/**
 * `/api/account/*` 与 `/api/users/:username` 的窄客户端。
 *
 * 与 `admin/api.ts`、`auth/api.ts` 同一套原则：页面只认这里的类型，`fetch` 的细节
 * （超时、cookie、错误体形状）不外泄；**所有函数都不抛异常**，返回可判别的结果。
 *
 * 与 `auth/api.ts` 的两处差别：
 *
 *   · **超时更长**。上传一张 4MB 的头像在慢网下 6 秒不够，所以上传单独给 30 秒。
 *   · **401 会广播**（`account:unauthorized`）。账号页据此把自己降级成客态卡，
 *     而不是留一堆「保存失败」的红字让人猜。
 */

import { parsePublicUser } from '../auth/api';
import {
  DEFAULT_THEME,
  type CustomBadge,
  type Gender,
  type MyProfile,
  type PrivacySettings,
  type ProfileData,
  type ProfileTheme,
  type ProfileVisibility,
  type PublicProfile,
  type SocialLink,
  type SystemBadge,
} from './types';

/* ---------------------------------------------------------------------------
   结果形状
--------------------------------------------------------------------------- */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; field?: string };

/** 会话过期时广播。账号页监听它把自己切成客态卡。 */
export const ACCOUNT_UNAUTHORIZED = 'account:unauthorized';

/** 公开主页查询的三种「正常」结局——它们都不是错误，所以不走失败分支。 */
export type PublicProfileResult =
  | { kind: 'ok'; profile: PublicProfile }
  | { kind: 'needs_login' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 30_000;

const OFFLINE_MESSAGE = '连不上后端服务，请确认 apps/api 已经启动。';

/* ---------------------------------------------------------------------------
   底层
--------------------------------------------------------------------------- */

async function call(path: string, init?: RequestInit, timeout = TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function failure(status: number, code: string, message: string, field?: string): ApiResult<never> {
  return { ok: false, status, code, message, ...(field ? { field } : {}) };
}

async function request<T>(path: string, init?: RequestInit, timeout = TIMEOUT_MS): Promise<ApiResult<T>> {
  const response = await call(path, init, timeout);
  if (!response) return failure(0, 'offline', OFFLINE_MESSAGE);

  if (response.ok) {
    const data = (await response.json().catch(() => null)) as T | null;
    if (data === null) return failure(response.status, 'bad_response', '后端返回了空响应，请刷新重试。');
    return { ok: true, data };
  }

  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(ACCOUNT_UNAUTHORIZED));
    return failure(401, 'unauthorized', '登录状态已失效，请重新登录。');
  }

  const body = (await response.json().catch(() => null)) as
    | { error?: unknown; message?: unknown; field?: unknown }
    | null;
  const code = typeof body?.error === 'string' ? body.error : 'unknown';
  const message =
    typeof body?.message === 'string' && body.message
      ? body.message
      : // Fastify 的 bodyLimit 抛的是纯文本 413，没有 message 字段。
        response.status === 413
        ? '文件太大了，超过了接口允许的上限（图片最多 8MB）。'
        : response.status === 415
          ? '只支持 PNG / JPEG / WebP / GIF / AVIF 图片。'
          : `请求失败（HTTP ${response.status}）。`;

  return failure(response.status, code, message, typeof body?.field === 'string' ? body.field : undefined);
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/* ---------------------------------------------------------------------------
   形状兜底
--------------------------------------------------------------------------- */

/**
 * 补齐缺失字段。
 *
 * 为什么要做：设置页的 draft 由这份对象驱动，少一个 `privacy.theme` 就会在渲染时
 * 炸成白屏；而「后端版本略旧」在本地开发里是常态（web 与 api 各自 watch 重启）。
 */
export function emptyProfile(): ProfileData {
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
    privacy: {
      signature: 'public',
      bio: 'public',
      gender: 'self',
      birthday: 'self',
      region: 'public',
      socials: 'public',
      tags: 'public',
      badges: 'public',
      lastLogin: 'self',
    },
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseTheme(raw: unknown): ProfileTheme {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    accent: asString(value.accent, DEFAULT_THEME.accent),
    accentStrong: asString(value.accentStrong, DEFAULT_THEME.accentStrong),
    surface: asString(value.surface, DEFAULT_THEME.surface),
    text: asString(value.text, DEFAULT_THEME.text),
  };
}

function parseProfile(raw: unknown): ProfileData {
  const base = emptyProfile();
  if (typeof raw !== 'object' || raw === null) return base;
  const value = raw as Record<string, unknown>;
  const privacy = (typeof value.privacy === 'object' && value.privacy !== null
    ? value.privacy
    : {}) as Record<string, unknown>;

  const merged = { ...base, ...value } as ProfileData;
  return {
    ...merged,
    version: 1,
    socials: asArray<SocialLink>(value.socials),
    tags: asArray<string>(value.tags).filter((tag) => typeof tag === 'string'),
    badges: asArray<CustomBadge>(value.badges),
    theme: parseTheme(value.theme),
    gender: (['male', 'female', 'other', 'none'] as const).includes(merged.gender)
      ? merged.gender
      : 'none',
    visibility: (['public', 'members', 'private'] as const).includes(merged.visibility)
      ? merged.visibility
      : 'public',
    privacy: { ...base.privacy, ...(privacy as PrivacySettings) },
  };
}

function parseMyProfile(raw: unknown): MyProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const user = parsePublicUser(value.user);
  if (!user) return null;
  const meta = (typeof value.meta === 'object' && value.meta !== null ? value.meta : {}) as Record<
    string,
    unknown
  >;
  return {
    user,
    profile: parseProfile(value.profile),
    meta: {
      lastLoginAt: typeof meta.lastLoginAt === 'string' ? meta.lastLoginAt : null,
      updatedAt: asString(meta.updatedAt),
    },
    systemBadges: asArray<SystemBadge>(value.systemBadges),
  };
}

/* ---------------------------------------------------------------------------
   本人接口
--------------------------------------------------------------------------- */

export async function fetchMyProfile(): Promise<ApiResult<MyProfile>> {
  const result = await request<unknown>('/api/account/profile');
  if (!result.ok) return result;
  const parsed = parseMyProfile(result.data);
  return parsed
    ? { ok: true, data: parsed }
    : failure(200, 'bad_response', '后端返回的资料不完整，请刷新重试。');
}

export interface ProfilePatchInput {
  nickname?: string;
  email?: string;
  currentPassword?: string;
  expectUpdatedAt?: string;
  signature?: string;
  bio?: string;
  gender?: Gender;
  birthday?: string;
  region?: string;
  socials?: SocialLink[];
  tags?: string[];
  badges?: CustomBadge[];
  theme?: ProfileTheme;
  visibility?: ProfileVisibility;
  privacy?: PrivacySettings;
  customCss?: string;
}

export async function patchMyProfile(patch: ProfilePatchInput): Promise<ApiResult<MyProfile>> {
  const result = await request<unknown>('/api/account/profile', jsonRequest('PATCH', patch));
  if (!result.ok) return result;
  const parsed = parseMyProfile(result.data);
  return parsed
    ? { ok: true, data: parsed }
    : failure(200, 'bad_response', '后端返回的资料不完整，请刷新重试。');
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<ApiResult<{ ok: true }>> {
  return request<{ ok: true }>('/api/account/password', jsonRequest('PUT', input));
}

/* ---------------------------------------------------------------------------
   媒体
--------------------------------------------------------------------------- */

export type MediaKind = 'avatar' | 'cover' | 'background';

/**
 * 上传头像 / 封面 / 背景。
 *
 * `content-type` **必须写死 `application/octet-stream`**：`File` 自带 `image/png`，
 * 而后端只给 octet-stream 注册了解析器，不写就是 415。
 *
 * 两个媒体接口都返回**完整资料**，前端直接替换手里那份即可。
 */
export async function uploadAccountMedia(
  kind: MediaKind,
  file: File,
): Promise<ApiResult<MyProfile>> {
  const result = await request<unknown>(
    `/api/account/media?kind=${kind}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    },
    UPLOAD_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  const parsed = parseMyProfile(result.data);
  return parsed
    ? { ok: true, data: parsed }
    : failure(200, 'bad_response', '后端返回的资料不完整，请刷新重试。');
}

export async function removeAccountMedia(kind: MediaKind): Promise<ApiResult<MyProfile>> {
  const result = await request<unknown>(`/api/account/media?kind=${kind}`, { method: 'DELETE' });
  if (!result.ok) return result;
  const parsed = parseMyProfile(result.data);
  return parsed
    ? { ok: true, data: parsed }
    : failure(200, 'bad_response', '后端返回的资料不完整，请刷新重试。');
}

/* ---------------------------------------------------------------------------
   公开主页
--------------------------------------------------------------------------- */

export function profileHref(username: string): string {
  return `#u/${encodeURIComponent(username)}`;
}

/**
 * 读别人的主页。
 *
 * 三种结局分开返回，因为它们对应三种完全不同的界面：正常渲染 / 「登录后可见」 /
 * 「没有这个人」。把它们压成 `ok:false` 会让调用方拿 HTTP 状态码去分支，很难读。
 */
export async function fetchPublicProfile(username: string): Promise<PublicProfileResult> {
  const response = await call(`/api/users/${encodeURIComponent(username)}`);
  if (!response) return { kind: 'error', message: OFFLINE_MESSAGE };

  if (response.status === 401) return { kind: 'needs_login' };
  if (response.status === 404) return { kind: 'missing' };
  if (!response.ok) {
    return { kind: 'error', message: `读取主页失败（HTTP ${response.status}）。` };
  }

  const data = (await response.json().catch(() => null)) as { profile?: unknown } | null;
  const raw = data?.profile;
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'error', message: '后端返回的主页不完整，请刷新重试。' };
  }
  const value = raw as Record<string, unknown>;
  const usernameValue = asString(value.username);
  const nicknameValue = asString(value.nickname);
  if (!usernameValue || !nicknameValue) {
    return { kind: 'error', message: '后端返回的主页不完整，请刷新重试。' };
  }

  const stats = (typeof value.stats === 'object' && value.stats !== null ? value.stats : {}) as Record<
    string,
    unknown
  >;

  return {
    kind: 'ok',
    profile: {
      username: usernameValue,
      nickname: nicknameValue,
      avatarUrl: asString(value.avatarUrl),
      role: value.role === 'admin' || value.role === 'owner' ? value.role : 'user',
      createdAt: asString(value.createdAt),
      isSelf: value.isSelf === true,
      visibility: (['public', 'members', 'private'] as const).includes(
        value.visibility as ProfileVisibility,
      )
        ? (value.visibility as ProfileVisibility)
        : 'public',
      coverUrl: asString(value.coverUrl),
      backgroundUrl: asString(value.backgroundUrl),
      theme: parseTheme(value.theme),
      signature: typeof value.signature === 'string' ? value.signature : null,
      bio: typeof value.bio === 'string' ? value.bio : null,
      gender: typeof value.gender === 'string' ? (value.gender as PublicProfile['gender']) : null,
      birthday: typeof value.birthday === 'string' ? value.birthday : null,
      region: typeof value.region === 'string' ? value.region : null,
      lastLoginAt: typeof value.lastLoginAt === 'string' ? value.lastLoginAt : null,
      socials: Array.isArray(value.socials) ? (value.socials as SocialLink[]) : null,
      tags: Array.isArray(value.tags) ? (value.tags as string[]) : null,
      customBadges: Array.isArray(value.customBadges) ? (value.customBadges as CustomBadge[]) : null,
      systemBadges: asArray<SystemBadge>(value.systemBadges),
      stats: {
        days: typeof stats.days === 'number' ? stats.days : 0,
        badges: typeof stats.badges === 'number' ? stats.badges : 0,
        tags: typeof stats.tags === 'number' ? stats.tags : 0,
      },
    },
  };
}
