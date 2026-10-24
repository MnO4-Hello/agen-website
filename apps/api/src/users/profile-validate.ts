/**
 * 个人资料的请求校验 + 对外裁剪。
 *
 * 与 `profile-types.ts` 的分工：那边负责「尽力修复」的归一化（读盘用），这边负责
 * 「只报错不修正」的校验（请求用）。两者取舍相反，混在一起就都不准了。
 *
 * 两条硬规则：
 *
 *   1. **未知键一律 400**。静默忽略会让前端拼错字段时变成「保存成功但没变」，
 *      这种 bug 没人能自己查出来。
 *   2. **媒体 URL 不可写**。`coverUrl` / `backgroundUrl` / `avatarUrl` 只能由上传
 *      接口写，PATCH 里出现就直接报错——否则用户能塞外站 URL（像素追踪 + 破图），
 *      而且设置页 draft 里的旧值会把刚上传的新封面覆盖回去。
 */

import type { PublicUser } from './types.js';
import { checkEmail, checkNickname, UserError, type UserField } from './validate.js';
import {
  BADGE_RESERVED,
  BADGE_RESERVED_PREFIX,
  DEFAULT_PRIVACY,
  PROFILE_FIELDS,
  PROFILE_LIMITS,
  PROFILE_MEDIA_KEYS,
  normalizeHex,
  textLength,
  type CustomBadge,
  type PrivacyLevel,
  type PrivacySettings,
  type ProfileData,
  type ProfileField,
  type ProfileTheme,
  type ProfileVisibility,
  type PublicProfile,
  type SocialLink,
  type SystemBadge,
} from './profile-types.js';

/* ---------------------------------------------------------------------------
   结果形状
--------------------------------------------------------------------------- */

/**
 * 校验后的局部更新。
 *
 * 缺省 = 「这次不改这个字段」。这与「改成空串」是两件事，所以每个键都必须
 * 能做到「不存在」，别用 `undefined` 混在里面。
 */
export interface ProfilePatch {
  nickname?: string;
  email?: string;
  /** 修改邮箱时必须带当前密码——邮箱是找回账号的唯一凭据。 */
  currentPassword?: string;
  expectUpdatedAt?: string;
  profile: Partial<Omit<ProfileData, 'version' | 'coverUrl' | 'backgroundUrl'>>;
}

export interface ParseContext {
  profile: ProfileData;
  systemBadges: SystemBadge[];
}

const PATCH_KEYS = new Set([
  'nickname',
  'email',
  'currentPassword',
  'expectUpdatedAt',
  'signature',
  'bio',
  'gender',
  'birthday',
  'region',
  'socials',
  'tags',
  'badges',
  'theme',
  'visibility',
  'privacy',
  'customCss',
]);

/** 明确拒绝的键：报错比「静默忽略」诚实。 */
const READONLY_KEYS = new Set([
  ...PROFILE_MEDIA_KEYS,
  'id',
  'username',
  'role',
  'status',
  'createdAt',
  'updatedAt',
  'lastLoginAt',
  'passwordHash',
  'password',
]);

/* ---------------------------------------------------------------------------
   基础读取
--------------------------------------------------------------------------- */

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserError(400, 'validation_error', `${label}的格式不对。`);
  }
  return value as Record<string, unknown>;
}

function readText(
  value: unknown,
  max: number,
  label: string,
  field: UserField,
  options: { multiline?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new UserError(400, 'validation_error', `${label}必须是文本。`, field);
  }
  // 控制符一律清掉，但多行字段要保住换行与制表符。
  const keep = options.multiline ? /\r\n?/g : /[\r\n\t]+/g;
  const clean = value
    .replace(keep, options.multiline ? '\n' : ' ')
    .replace(
      options.multiline
        ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
        : /[\u0000-\u001f\u007f]/g,
      '',
    )
    .replace(/[\u200b-\u200f\u2028\u2029]/g, '')
    .trim();

  if (textLength(clean) > max) {
    throw new UserError(400, 'validation_error', `${label}最多 ${max} 个字符。`, field);
  }
  return clean;
}

/* ---------------------------------------------------------------------------
   自定义 CSS
--------------------------------------------------------------------------- */

/**
 * 禁掉这些 at-rule 与函数：
 *
 *   · `@import` —— 会把站外样式表拉进来，等同任意内容注入 + 泄漏访客 IP；
 *   · `@font-face` —— 字体名是全局的，`src: url()` 还能外连；
 *   · `url()` —— 图片一律走上传接口，允许外链等于送用户一个像素追踪器；
 *   · `@property` / `@layer` —— 能注册或改写全局自定义属性，是越界的第一步。
 *
 * 客户端的 CSSOM 作用域化是第二道防线，不是替代品：老数据里可能已经存了脏东西。
 */
const CSS_FORBIDDEN =
  /@(import|charset|namespace|font-face|page|property|layer|counter-style|scope)\b|url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|<\s*\/?\s*(script|style|iframe)/i;

const CSS_BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

/** 返回第一个「没闭合的左括号」所在行号；括号多余时返回多余那行的行号。 */
function findUnbalancedBrace(css: string): number | null {
  let depth = 0;
  let line = 1;
  let openLine = 1;
  for (const ch of css) {
    if (ch === '\n') {
      line += 1;
    } else if (ch === '{') {
      if (depth === 0) openLine = line;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return line;
    }
  }
  return depth === 0 ? null : openLine;
}

export function checkCss(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserError(400, 'validation_error', '自定义 CSS 必须是文本。', 'customCss');
  }
  const css = value.replace(/\r\n?/g, '\n').replace(CSS_BAD_CHARS, '');
  // 按**字节**算：中文注释一个字 3 字节，按字符算会放进来三倍体积。
  if (Buffer.byteLength(css, 'utf8') > PROFILE_LIMITS.cssBytes) {
    throw new UserError(
      400,
      'css_invalid',
      `自定义 CSS 最多 ${PROFILE_LIMITS.cssBytes / 1024}KB（按 UTF-8 字节算，中文一个字 3 字节）。`,
      'customCss',
    );
  }

  const scan = stripComments(css);
  const hit = CSS_FORBIDDEN.exec(scan);
  if (hit) {
    throw new UserError(400, 'css_invalid', `不允许使用 ${hit[0]}。`, 'customCss');
  }
  const bad = findUnbalancedBrace(scan);
  if (bad !== null) {
    throw new UserError(400, 'css_invalid', `第 ${bad} 行附近的大括号没有闭合。`, 'customCss');
  }
  return css;
}

/* ---------------------------------------------------------------------------
   各字段
--------------------------------------------------------------------------- */

function parseBirthday(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserError(400, 'validation_error', '生日必须是文本。', 'birthday');
  }
  const raw = value.trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new UserError(400, 'validation_error', '生日请用「年-月-日」的格式。', 'birthday');
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new UserError(400, 'validation_error', '这一天不存在，检查一下日期。', 'birthday');
  }

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  if (raw > today) {
    throw new UserError(400, 'validation_error', '生日不能是未来的日期。', 'birthday');
  }
  if (raw < '1900-01-01') {
    throw new UserError(400, 'validation_error', '生日太早了，请填 1900 年之后的日期。', 'birthday');
  }
  return raw;
}

function parseUrl(value: unknown, label: string, field: UserField): string {
  if (typeof value !== 'string') {
    throw new UserError(400, 'validation_error', `${label}必须是文本。`, field);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new UserError(400, 'validation_error', `${label}不能为空。`, field);
  }
  if (trimmed.length > PROFILE_LIMITS.linkUrl) {
    throw new UserError(400, 'validation_error', `${label}太长了。`, field);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UserError(400, 'validation_error', `${label}不是一个合法地址。`, field);
  }
  // 只放行 http(s)：`javascript:` 之类的地址会被原样渲染成可点的链接。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError(400, 'validation_error', `${label}只能填 http 或 https 地址。`, field);
  }
  return url.href;
}

function newLocalId(prefix: 'b' | 's'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

function parseSocials(value: unknown, base: SocialLink[]): SocialLink[] {
  if (!Array.isArray(value)) {
    throw new UserError(400, 'validation_error', '社交链接的格式不对。', 'socials');
  }
  if (value.length > PROFILE_LIMITS.linkCount) {
    throw new UserError(
      400,
      'validation_error',
      `社交链接最多 ${PROFILE_LIMITS.linkCount} 条。`,
      'socials',
    );
  }
  const baseIds = new Set(base.map((item) => item.id));
  return value.map((item) => {
    const raw = asObject(item, '社交链接');
    const label = readText(raw.label, PROFILE_LIMITS.linkLabel, '链接名称', 'socials');
    if (!label) {
      throw new UserError(400, 'validation_error', '每条链接都要有名称。', 'socials');
    }
    const url = parseUrl(raw.url, '链接地址', 'socials');
    // 客户端可以带 id（用来保持列表稳定），但只认它自己那份列表里出现过的。
    const id =
      typeof raw.id === 'string' && baseIds.has(raw.id) ? raw.id : newLocalId('s');
    return { id, label, url };
  });
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new UserError(400, 'validation_error', '标签的格式不对。', 'tags');
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new UserError(400, 'validation_error', '标签必须是文本。', 'tags');
    }
    const tag = readText(item, PROFILE_LIMITS.tagLength, '单个标签', 'tags');
    if (!tag) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > PROFILE_LIMITS.tagCount) {
    throw new UserError(400, 'validation_error', `标签最多 ${PROFILE_LIMITS.tagCount} 个。`, 'tags');
  }
  return out;
}

function badgeKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function parseBadges(value: unknown, systemBadges: SystemBadge[]): CustomBadge[] {
  if (!Array.isArray(value)) {
    throw new UserError(400, 'validation_error', '徽章的格式不对。', 'badges');
  }
  if (value.length > PROFILE_LIMITS.badgeCount) {
    throw new UserError(
      400,
      'validation_error',
      `徽章最多 ${PROFILE_LIMITS.badgeCount} 枚。`,
      'badges',
    );
  }

  const takenSystem = new Set(systemBadges.map((badge) => badgeKey(badge.label)));
  const seen = new Set<string>();

  return value.map((item) => {
    const raw = asObject(item, '徽章');
    const label = readText(raw.label, PROFILE_LIMITS.badgeLabel, '徽章名称', 'badges');
    if (!label) {
      throw new UserError(400, 'validation_error', '徽章不能没有名字。', 'badges');
    }
    const key = badgeKey(label);
    if (BADGE_RESERVED.has(key)) {
      throw new UserError(
        400,
        'badge_reserved',
        `「${label}」是保留名称，换一个吧。`,
        'badges',
      );
    }
    if (BADGE_RESERVED_PREFIX.test(label)) {
      throw new UserError(
        400,
        'badge_reserved',
        '徽章名不能以对勾或盾牌开头——那是系统徽章的样子。',
        'badges',
      );
    }
    if (takenSystem.has(key)) {
      throw new UserError(
        400,
        'badge_reserved',
        `「${label}」和系统徽章重名了，换一个吧。`,
        'badges',
      );
    }
    if (seen.has(key)) {
      throw new UserError(400, 'validation_error', `有两枚徽章都叫「${label}」。`, 'badges');
    }
    seen.add(key);

    const color = normalizeHex(raw.color);
    if (!color) {
      throw new UserError(400, 'validation_error', '徽章颜色要写成 #rrggbb。', 'badges');
    }
    const emoji = readText(raw.emoji ?? '', PROFILE_LIMITS.badgeEmoji, '徽章图标', 'badges');

    // id 由服务端生成：客户端传什么都不能信，否则可以拿它去撞系统徽章的 key。
    return { id: newLocalId('b'), label, color, emoji };
  });
}

function parseTheme(value: unknown, base: ProfileTheme): ProfileTheme {
  const raw = asObject(value, '主题配色');
  const read = (key: keyof ProfileTheme, label: string): string => {
    const hex = normalizeHex(raw[key]);
    if (!hex) {
      throw new UserError(400, 'validation_error', `${label}要写成 #rrggbb。`, 'theme');
    }
    return hex;
  };
  return {
    accent: raw.accent === undefined ? base.accent : read('accent', '主色'),
    accentStrong: raw.accentStrong === undefined ? base.accentStrong : read('accentStrong', '深主色'),
    surface: raw.surface === undefined ? base.surface : read('surface', '背景色'),
    text: raw.text === undefined ? base.text : read('text', '文字色'),
  };
}

function parsePrivacy(value: unknown, base: PrivacySettings): PrivacySettings {
  const raw = asObject(value, '隐私设置');
  const out: PrivacySettings = { ...base };
  for (const [key, level] of Object.entries(raw)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
      throw new UserError(400, 'validation_error', `未知的隐私字段：${key}。`, 'privacy');
    }
    if (level !== 'public' && level !== 'self' && level !== 'hidden') {
      throw new UserError(
        400,
        'validation_error',
        '隐私档位只能是 public / self / hidden。',
        'privacy',
      );
    }
    out[key as ProfileField] = level as PrivacyLevel;
  }
  return out;
}

function parseVisibility(value: unknown): ProfileVisibility {
  if (value === 'public' || value === 'members' || value === 'private') return value;
  throw new UserError(
    400,
    'validation_error',
    '主页可见性只能是 public / members / private。',
    'visibility',
  );
}

/* ---------------------------------------------------------------------------
   入口
--------------------------------------------------------------------------- */

export function parseProfilePatch(body: unknown, ctx: ParseContext): ProfilePatch {
  const raw = asObject(body, '请求');
  const profile: ProfilePatch['profile'] = {};
  const patch: ProfilePatch = { profile };

  for (const key of Object.keys(raw)) {
    if (READONLY_KEYS.has(key)) {
      throw new UserError(400, 'invalid_body', `字段 ${key} 不能通过这个接口修改。`);
    }
    if (!PATCH_KEYS.has(key)) {
      throw new UserError(400, 'invalid_body', `未知字段：${key}。`);
    }
  }

  const present = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);

  if (present('nickname')) {
    const nickname = readText(raw.nickname, 24, '昵称', 'nickname');
    checkNickname(nickname);
    patch.nickname = nickname;
  }
  if (present('email')) {
    const email = readText(raw.email, 254, '邮箱', 'email');
    checkEmail(email);
    patch.email = email;
  }
  if (present('currentPassword')) {
    if (typeof raw.currentPassword !== 'string') {
      throw new UserError(400, 'validation_error', '当前密码必须是文本。', 'currentPassword');
    }
    patch.currentPassword = raw.currentPassword;
  }
  if (present('expectUpdatedAt')) {
    if (typeof raw.expectUpdatedAt !== 'string') {
      throw new UserError(400, 'invalid_body', 'expectUpdatedAt 必须是时间字符串。');
    }
    patch.expectUpdatedAt = raw.expectUpdatedAt;
  }

  if (present('signature')) {
    profile.signature = readText(raw.signature, PROFILE_LIMITS.signature, '一句话签名', 'signature');
  }
  if (present('bio')) {
    profile.bio = readText(raw.bio, PROFILE_LIMITS.bio, '简介', 'bio', { multiline: true });
  }
  if (present('gender')) {
    const value = raw.gender;
    if (value !== 'male' && value !== 'female' && value !== 'other' && value !== 'none') {
      throw new UserError(400, 'validation_error', '性别只能是 male / female / other / none。', 'gender');
    }
    profile.gender = value;
  }
  if (present('birthday')) profile.birthday = parseBirthday(raw.birthday);
  if (present('region')) {
    profile.region = readText(raw.region, PROFILE_LIMITS.region, '地区', 'region');
  }
  if (present('socials')) profile.socials = parseSocials(raw.socials, ctx.profile.socials);
  if (present('tags')) profile.tags = parseTags(raw.tags);
  if (present('badges')) profile.badges = parseBadges(raw.badges, ctx.systemBadges);
  if (present('theme')) profile.theme = parseTheme(raw.theme, ctx.profile.theme);
  if (present('visibility')) profile.visibility = parseVisibility(raw.visibility);
  if (present('privacy')) profile.privacy = parsePrivacy(raw.privacy, ctx.profile.privacy);
  if (present('customCss')) profile.customCss = checkCss(raw.customCss);

  return patch;
}

/* ---------------------------------------------------------------------------
   对外裁剪
--------------------------------------------------------------------------- */

function visible(field: ProfileField, profile: ProfileData, isSelf: boolean): boolean {
  const level = profile.privacy[field] ?? DEFAULT_PRIVACY[field];
  if (level === 'hidden') return false;
  if (level === 'self') return isSelf;
  return true;
}

/**
 * 把 `UserRecord` 裁成公开形状。
 *
 * **这是唯一一处做可见性判断的地方**——路由层不许自己判，否则早晚会出现
 * 「这个接口记得过滤、那个接口忘了」。
 */
export function toPublicProfile(
  user: PublicUser,
  profile: ProfileData,
  lastLoginAt: string | null,
  isSelf: boolean,
  systemBadges: SystemBadge[],
  now = Date.now(),
): PublicProfile {
  const customBadges = visible('badges', profile, isSelf) ? profile.badges : null;
  const tags = visible('tags', profile, isSelf) ? profile.tags : null;

  const born = new Date(user.createdAt).getTime();
  const days = Number.isFinite(born) ? Math.max(0, Math.floor((now - born) / 86_400_000)) : 0;

  return {
    username: user.username,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    isSelf,
    visibility: profile.visibility,
    coverUrl: profile.coverUrl,
    backgroundUrl: profile.backgroundUrl,
    theme: profile.theme,
    signature: visible('signature', profile, isSelf) && profile.signature ? profile.signature : null,
    bio: visible('bio', profile, isSelf) && profile.bio ? profile.bio : null,
    gender: visible('gender', profile, isSelf) && profile.gender !== 'none' ? profile.gender : null,
    birthday: visible('birthday', profile, isSelf) && profile.birthday ? profile.birthday : null,
    region: visible('region', profile, isSelf) && profile.region ? profile.region : null,
    lastLoginAt: visible('lastLogin', profile, isSelf) ? lastLoginAt : null,
    socials: visible('socials', profile, isSelf) && profile.socials.length > 0 ? profile.socials : null,
    tags: tags && tags.length > 0 ? tags : null,
    customBadges: customBadges && customBadges.length > 0 ? customBadges : null,
    systemBadges,
    stats: {
      days,
      badges: systemBadges.length + (customBadges?.length ?? 0),
      tags: tags?.length ?? 0,
    },
  };
}
