/**
 * 个人资料的**形状与默认值**。
 *
 * 这些字段挂在 `UserRecord.profile` 上，仍然存 `data/users.json`——为什么不分文件，
 * 见 `users/store.ts` 顶部那段「一次保存 = 一次原子写」的说明。
 *
 * 三件必须一起做的事，全在这个文件里：
 *
 *   1. **默认值**唯一真源（`defaultProfile()`）。老记录没有 `profile` 字段时补它。
 *   2. **归一化**（`normalizeProfile()`）——纯内存、不落盘、不丢未知键。它挡的是
 *      「有人手改了 users.json」这种情况：塞 1MB 的 CSS、把颜色写成 `red`、
 *      把 `privacy` 写成字符串。挡住之后下一次真实写入自然带上干净的结构。
 *   3. **系统徽章**的计算规则（`systemBadgesOf()`）。这部分不受隐私开关影响，
 *      也不接受客户端提交。
 *
 * ⚠️ 这里**不做**面向请求体的校验（那是 `profile-validate.ts` 的活）：归一化要
 * 「尽力修复」，校验要「只报错不修正」。两者的取舍正好相反，混在一起就都不准了。
 */

import type { PublicUser, Role } from './types.js';

/* ---------------------------------------------------------------------------
   基本类型
--------------------------------------------------------------------------- */

/** 逐字段隐私：公开 / 仅自己 / 完全不展示。 */
export type PrivacyLevel = 'public' | 'self' | 'hidden';

export type Gender = 'male' | 'female' | 'other' | 'none';

/** 主页整体可见性——也就是「游客开关」。 */
export type ProfileVisibility = 'public' | 'members' | 'private';

/**
 * 九项可配隐私的字段。
 *
 * 昵称 / 头像 / 用户名**不在此列**：昵称头像是「这是谁」的最低信息，用户名还是
 * URL 的一部分（`#u/<username>`），做成可隐藏没有意义。UI 上给它们标「必显」。
 */
export const PROFILE_FIELDS = [
  'signature',
  'bio',
  'gender',
  'birthday',
  'region',
  'socials',
  'tags',
  'badges',
  'lastLogin',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type PrivacySettings = Record<ProfileField, PrivacyLevel>;

export interface SocialLink {
  /** `s-` + 8 位 36 进制。只用于列表 key 与删除定位，不是安全边界。 */
  id: string;
  label: string;
  /** 只允许 http(s)——`javascript:` 会被直接渲染成可点的链接。 */
  url: string;
}

export interface CustomBadge {
  /** `b-` + 8 位 36 进制。服务端重新生成，不信客户端。 */
  id: string;
  label: string;
  /** 恒为 6 位小写十六进制（`#rrggbb`）。 */
  color: string;
  /** 0–8 个码点，允许空串。 */
  emoji: string;
}

export interface ProfileTheme {
  accent: string;
  accentStrong: string;
  surface: string;
  text: string;
}

export interface ProfileData {
  version: 1;
  signature: string;
  bio: string;
  gender: Gender;
  birthday: string;
  region: string;
  socials: SocialLink[];
  tags: string[];
  badges: CustomBadge[];
  theme: ProfileTheme;
  coverUrl: string;
  backgroundUrl: string;
  customCss: string;
  visibility: ProfileVisibility;
  privacy: PrivacySettings;
}

/* ---------------------------------------------------------------------------
   上限与常量
--------------------------------------------------------------------------- */

export const PROFILE_LIMITS = {
  signature: 40,
  bio: 300,
  region: 32,
  tagLength: 16,
  tagCount: 8,
  linkCount: 6,
  linkLabel: 16,
  linkUrl: 300,
  badgeCount: 12,
  badgeLabel: 12,
  badgeEmoji: 8,
  cssBytes: 8192,
} as const;

/** 账号媒体的 URL 前缀与命名。`profile-media.ts` 与归一化共用这一份。 */
export const ACCOUNT_MEDIA_PREFIX = '/api/account/media/';

/** `a-` + 内容 sha1 前 16 位 + 由 magic byte 决定的扩展名。 */
export const ACCOUNT_MEDIA_RE = /^a-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;

/**
 * 三个媒体字段。
 *
 * 它们**不在** PATCH 的可写范围里：只能由上传接口写。原因见 `store.saveProfile()`。
 */
export const PROFILE_MEDIA_KEYS = ['avatarUrl', 'coverUrl', 'backgroundUrl'] as const;

export const DEFAULT_THEME: ProfileTheme = {
  accent: '#3f7d58',
  accentStrong: '#2f6244',
  surface: '#f2f7f0',
  text: '#1f3d2b',
};

/**
 * 隐私默认值。
 *
 * 生日与性别默认 `self`、最后登录时间默认 `self`：这三项在国内语境下最敏感，
 * 默认公开是要挨骂的。其余展示型字段默认公开——用户填了签名却没人看见，
 * 会以为功能坏了。
 */
export const DEFAULT_PRIVACY: PrivacySettings = {
  signature: 'public',
  bio: 'public',
  gender: 'self',
  birthday: 'self',
  region: 'public',
  socials: 'public',
  tags: 'public',
  badges: 'public',
  lastLogin: 'self',
};

export function defaultProfile(): ProfileData {
  return {
    version: 1,
    signature: '',
    bio: '',
    gender: 'none',
    birthday: '',
    region: '',
    socials: [],
    tags: [],
    badges: [],
    theme: { ...DEFAULT_THEME },
    coverUrl: '',
    backgroundUrl: '',
    customCss: '',
    visibility: 'public',
    privacy: { ...DEFAULT_PRIVACY },
  };
}

/* ---------------------------------------------------------------------------
   小工具
--------------------------------------------------------------------------- */

const BAD_ID_RE = /^[bs]-[a-z0-9]{4,12}$/;
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BAD_TEXT_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/;

/** 码点长度（emoji 与中文都算 1），并且不许控制符/零宽字符。 */
export function textLength(value: string): number {
  return Array.from(value).length;
}

function clampText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(BAD_TEXT_RE, '');
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join('') : clean;
}

/** `#abc` → `#aabbcc`；认不出来的返回 `null`（调用方决定用默认值还是报错）。 */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!HEX_RE.test(raw)) return null;
  if (raw.length === 7) return raw;
  const [, r, g, b] = raw;
  return `#${r}${r}${g}${g}${b}${b}`;
}

function newId(prefix: 'b' | 's'): string {
  // 8 位 36 进制 ≈ 2.8 万亿种，够用了；不需要密码学强度。
  return `${prefix}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

function genderOf(value: unknown): Gender {
  return value === 'male' || value === 'female' || value === 'other' || value === 'none'
    ? value
    : 'none';
}

function visibilityOf(value: unknown): ProfileVisibility {
  return value === 'members' || value === 'private' || value === 'public' ? value : 'public';
}

function privacyOf(value: unknown): PrivacySettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PRIVACY };
  for (const field of PROFILE_FIELDS) {
    const level = raw[field];
    if (level === 'public' || level === 'self' || level === 'hidden') out[field] = level;
  }
  return out;
}

function themeOf(value: unknown): ProfileTheme {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    accent: normalizeHex(raw.accent) ?? DEFAULT_THEME.accent,
    accentStrong: normalizeHex(raw.accentStrong) ?? DEFAULT_THEME.accentStrong,
    surface: normalizeHex(raw.surface) ?? DEFAULT_THEME.surface,
    text: normalizeHex(raw.text) ?? DEFAULT_THEME.text,
  };
}

/** 只接受本站上传接口产出的路径；外站 URL 一律丢弃（否则等于允许像素追踪 + 破图）。 */
function mediaUrlOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value.startsWith(ACCOUNT_MEDIA_PREFIX)) return '';
  return ACCOUNT_MEDIA_RE.test(value.slice(ACCOUNT_MEDIA_PREFIX.length)) ? value : '';
}

function birthdayOf(value: unknown): string {
  if (typeof value !== 'string' || !BIRTHDAY_RE.test(value)) return '';
  // 只做「是不是一个真实存在的日期」的判断；范围校验留给请求校验层。
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10) === value ? value : '';
}

function socialsOf(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) return [];
  const out: SocialLink[] = [];
  for (const item of value.slice(0, PROFILE_LIMITS.linkCount)) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const label = clampText(raw.label, PROFILE_LIMITS.linkLabel).trim();
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!label || !url) continue;
    const id = typeof raw.id === 'string' && BAD_ID_RE.test(raw.id) ? raw.id : newId('s');
    out.push({ id, label, url });
  }
  return out;
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = clampText(item, PROFILE_LIMITS.tagLength).trim();
    if (!tag) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= PROFILE_LIMITS.tagCount) break;
  }
  return out;
}

function badgesOf(value: unknown): CustomBadge[] {
  if (!Array.isArray(value)) return [];
  const out: CustomBadge[] = [];
  for (const item of value.slice(0, PROFILE_LIMITS.badgeCount)) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const label = clampText(raw.label, PROFILE_LIMITS.badgeLabel).trim();
    const color = normalizeHex(raw.color);
    // 颜色认不出来就整枚丢掉：给一个「无色徽章」反而会让人以为样式坏了。
    if (!label || !color) continue;
    const id = typeof raw.id === 'string' && BAD_ID_RE.test(raw.id) ? raw.id : newId('b');
    out.push({ id, label, color, emoji: clampText(raw.emoji, PROFILE_LIMITS.badgeEmoji).trim() });
  }
  return out;
}

/* ---------------------------------------------------------------------------
   归一化
--------------------------------------------------------------------------- */

/**
 * 把任意形状的输入捏成合法的 `ProfileData`。
 *
 * 只用于**读盘**（`parseState`）与**服务端写入前的兜底**，不用于请求校验：
 * 请求校验要报错，这里只求「别把整份 users.json 读崩」。
 */
export function normalizeProfile(raw: unknown): ProfileData {
  const base = defaultProfile();
  if (typeof raw !== 'object' || raw === null) return base;
  const src = raw as Record<string, unknown>;

  // 超限的 CSS 整块丢弃而不是截断：截在半条规则上，页面会诡异地错位，
  // 不如干干净净地回到默认样式。
  const css = typeof src.customCss === 'string' ? src.customCss : '';
  const cssBytes = Buffer.byteLength(css, 'utf8');

  return {
    version: 1,
    signature: clampText(src.signature, PROFILE_LIMITS.signature),
    bio: clampText(src.bio, PROFILE_LIMITS.bio),
    gender: genderOf(src.gender),
    birthday: birthdayOf(src.birthday),
    region: clampText(src.region, PROFILE_LIMITS.region).trim(),
    socials: socialsOf(src.socials),
    tags: tagsOf(src.tags),
    badges: badgesOf(src.badges),
    theme: themeOf(src.theme),
    coverUrl: mediaUrlOf(src.coverUrl),
    backgroundUrl: mediaUrlOf(src.backgroundUrl),
    customCss: cssBytes > PROFILE_LIMITS.cssBytes ? '' : css,
    visibility: visibilityOf(src.visibility),
    privacy: privacyOf(src.privacy),
  };
}

/* ---------------------------------------------------------------------------
   系统徽章
--------------------------------------------------------------------------- */

export type SystemBadgeId = 'role-owner' | 'role-admin' | 'year' | 'early';

/**
 * 系统徽章：由服务端根据账号信息算出，**不接受客户端提交**。
 *
 * 与用户自建徽章分成两个字段下发（`PublicProfile.systemBadges` /
 * `PublicProfile.customBadges`），渲染上也必须长得不一样——见 `account.css` 里
 * `.acc-badge--system` 的实心底 + 「系统」角标。用户能自建徽章，如果两种长得一样，
 * 任何人五分钟就能自封「官方认证」。
 */
export interface SystemBadge {
  id: SystemBadgeId;
  kind: 'system';
  label: string;
  color: string;
  emoji: string;
  hint: string;
}

/** 前 10 个注册的账号算「早期用户」。 */
const EARLY_LIMIT = 10;

export function systemBadgesOf(
  role: Role,
  createdAt: string,
  userIndex: number,
): SystemBadge[] {
  const out: SystemBadge[] = [];

  if (role === 'owner') {
    out.push({
      id: 'role-owner',
      kind: 'system',
      label: '站长',
      color: '#2f6244',
      emoji: '',
      hint: '站点所有者',
    });
  } else if (role === 'admin') {
    out.push({
      id: 'role-admin',
      kind: 'system',
      label: '管理员',
      color: '#4c6f8a',
      emoji: '',
      hint: '站点管理员',
    });
  }
  // `role === 'user'` 不发角色徽章：人人一枚等于没有。

  const year = new Date(createdAt).getUTCFullYear();
  if (Number.isFinite(year)) {
    out.push({
      id: 'year',
      kind: 'system',
      label: `${year} 年加入`,
      color: '#7d6a3f',
      emoji: '',
      hint: '注册年份',
    });
  }

  if (userIndex >= 0 && userIndex < EARLY_LIMIT) {
    out.push({
      id: 'early',
      kind: 'system',
      label: '早期用户',
      color: '#3f7d70',
      emoji: '',
      hint: `前 ${EARLY_LIMIT} 位注册`,
    });
  }

  return out;
}

/** 自建徽章不能用的名字：撞上就等于伪造身份。比较前会 NFKC + 折叠空白 + 小写。 */
export const BADGE_RESERVED = new Set([
  '官方',
  '认证',
  '已认证',
  '官方认证',
  '站长',
  '管理员',
  '系统',
  '客服',
  '版主',
  '审核',
  'official',
  'verified',
  'admin',
  'owner',
  'system',
  'staff',
  'moderator',
  'support',
]);

/** 以对勾/盾牌开头是最常见的伪造手法（`✔ 官方认证` 与 `官方认证` 归一化后不同）。 */
export const BADGE_RESERVED_PREFIX = /^[✔✓✅☑🛡🔰⭐★]/;

/* ---------------------------------------------------------------------------
   对外的两个形状
--------------------------------------------------------------------------- */

/**
 * 本人看到的完整资料。
 *
 * 与 `PublicProfile` 分开而不复用同一份：`profile` 里有 `privacy` 配置本身，
 * 公开页下发它等于告诉访客「他隐藏了生日」——这本身就是信息泄漏。
 */
export interface MyProfile {
  user: PublicUser;
  profile: ProfileData;
  meta: {
    lastLoginAt: string | null;
    /** 资料最后修改时间（换头像/封面不会动它，见 `store.setMedia()`）。 */
    updatedAt: string;
  };
  systemBadges: SystemBadge[];
}

/**
 * 公开主页的载荷。
 *
 * 被隐私开关裁掉的字段是 **`null`** 而不是空串/空数组——这样「隐藏了」与「没填」
 * 对访客完全一致，前端统一按「不存在就不渲染这一块」处理。
 *
 * 这里**没有 `customCss`**：公开页不渲染别人的自定义样式，能省掉一整类注入面积。
 */
export interface PublicProfile {
  username: string;
  nickname: string;
  avatarUrl: string;
  role: Role;
  createdAt: string;
  isSelf: boolean;
  visibility: ProfileVisibility;
  coverUrl: string;
  backgroundUrl: string;
  theme: ProfileTheme;
  signature: string | null;
  bio: string | null;
  gender: Gender | null;
  birthday: string | null;
  region: string | null;
  lastLoginAt: string | null;
  socials: SocialLink[] | null;
  tags: string[] | null;
  customBadges: CustomBadge[] | null;
  systemBadges: SystemBadge[];
  stats: { days: number; badges: number; tags: number };
}
