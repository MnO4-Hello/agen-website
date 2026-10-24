/**
 * `/api/auth/*` 的窄客户端。
 *
 * 与 `admin/api.ts`、`works/api.ts` 同一套原则：**页面只认这里的类型**，`fetch` 的
 * 细节（超时、cookie、错误体形状）不外泄；所有函数都**不抛异常**，返回可判别的结果。
 *
 * 为什么「不抛」在这里尤其重要：`main.ts` 会在页面挂载之后静默问一次会话，
 * 后端没起、断网、超时都不该让整站白屏——那只是一次「你现在是谁」的查询。
 */

export type Role = 'user' | 'admin' | 'owner';

/** 与后端 `PublicUser` 一一对应；**永远不会有 passwordHash / key 字段**。 */
export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  email: string;
  role: Role;
  avatarUrl: string;
  createdAt: string;
}

/** 服务端会指出该红哪个输入框。 */
export type AuthField = 'username' | 'nickname' | 'email' | 'password' | 'confirmPassword' | 'agreed';

export type AuthCode =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'validation_error'
  | 'terms_required'
  | 'username_taken'
  | 'nickname_taken'
  | 'email_taken'
  | 'invalid_body'
  | 'too_many_attempts'
  | 'offline'
  | 'timeout'
  | 'user_store_error'
  | 'unknown';

export interface AuthFailure {
  ok: false;
  code: AuthCode;
  /** 直接可显示的一句中文。 */
  message: string;
  field?: AuthField;
  retryAfterSeconds?: number;
}

export type AuthSuccess = { ok: true; user: PublicUser };
export type AuthResult = AuthSuccess | AuthFailure;

/** 一次会话查询：`ok` 但 `user === null` 就是游客。 */
export type SessionResult = { ok: true; user: PublicUser | null } | { ok: false; message: string };

/** 后端在本机，6 秒还没回基本就是没起。 */
const TIMEOUT_MS = 6000;

/** 表单提交值；`confirmPassword` 也会发给服务端再比一次（绕过界面直连接口时的兜底）。 */
export interface RegisterInput {
  username: string;
  nickname: string;
  email: string;
  password: string;
  confirmPassword: string;
  agreed: boolean;
}

export interface LoginInput {
  identifier: string;
  password: string;
}

/* ---------------------------------------------------------------------------
   底层
--------------------------------------------------------------------------- */

/** 兜底文案：连不上后端时用。 */
const OFFLINE_MESSAGE = '连不上后端服务，请确认 apps/api 已经启动。';

async function call(path: string, init?: RequestInit): Promise<Response | AuthFailure> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`/api/auth${path}`, {
      // 会话在 HttpOnly cookie 里，必须带凭据；这类响应一律不许缓存。
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'timeout' : 'offline',
      message: aborted ? '后端响应太慢，请稍后再试。' : OFFLINE_MESSAGE,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function isFailure(value: Response | AuthFailure): value is AuthFailure {
  return !(value instanceof Response);
}

/** 后端给了 `message` 就用它（那是给最终用户看的一句话），否则用一句兜底。 */
async function toFailure(response: Response, fallback: string): Promise<AuthFailure> {
  const data = (await response.json().catch(() => null)) as
    | { error?: unknown; message?: unknown; field?: unknown; retryAfterSeconds?: unknown }
    | null;

  const code = typeof data?.error === 'string' ? (data.error as AuthCode) : 'unknown';
  const message =
    typeof data?.message === 'string' && data.message
      ? data.message
      : code === 'invalid_credentials'
        ? '用户名/邮箱或密码不对。'
        : fallback;

  return {
    ok: false,
    code,
    message,
    ...(typeof data?.field === 'string' ? { field: data.field as AuthField } : {}),
    ...(typeof data?.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: data.retryAfterSeconds }
      : {}),
  };
}

/** 形状检查：宁可当成游客，也不要把半个对象塞进界面。 */
export function parsePublicUser(raw: unknown): PublicUser | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.nickname !== 'string') return null;
  if (typeof value.username !== 'string' || typeof value.role !== 'string') return null;

  return {
    id: value.id,
    username: value.username,
    nickname: value.nickname,
    email: typeof value.email === 'string' ? value.email : '',
    role: value.role === 'admin' || value.role === 'owner' ? value.role : 'user',
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  };
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/* ---------------------------------------------------------------------------
   接口
--------------------------------------------------------------------------- */

export async function fetchSession(): Promise<SessionResult> {
  const response = await call('/session');
  if (isFailure(response)) return { ok: false, message: response.message };
  if (!response.ok) {
    const failure = await toFailure(response, '读取登录状态失败。');
    return { ok: false, message: failure.message };
  }

  const data = (await response.json().catch(() => null)) as
    | { authenticated?: unknown; user?: unknown }
    | null;
  if (!data || data.authenticated !== true) return { ok: true, user: null };

  const user = parsePublicUser(data.user);
  // 后端说登录了但用户对象读不懂：当作游客，别拿半个对象去画头像。
  return { ok: true, user };
}

export async function postLogin(input: LoginInput): Promise<AuthResult> {
  const response = await call('/login', jsonPost(input));
  if (isFailure(response)) return response;

  if (response.ok) {
    const data = (await response.json().catch(() => null)) as { user?: unknown } | null;
    const user = parsePublicUser(data?.user);
    if (user) return { ok: true, user };
    return { ok: false, code: 'unknown', message: '后端返回的账号信息不完整，请刷新重试。' };
  }

  if (response.status === 429) {
    return toFailure(response, '尝试次数太多了，请稍后再试。');
  }
  return toFailure(response, '登录失败，请稍后再试。');
}

export async function postRegister(input: RegisterInput): Promise<AuthResult> {
  const response = await call('/register', jsonPost(input));
  if (isFailure(response)) return response;

  if (response.ok) {
    const data = (await response.json().catch(() => null)) as { user?: unknown } | null;
    const user = parsePublicUser(data?.user);
    if (user) return { ok: true, user };
    return { ok: false, code: 'unknown', message: '后端返回的账号信息不完整，请刷新重试。' };
  }

  return toFailure(response, '注册失败，请稍后再试。');
}

/** 登出。失败也当成功——本地的会话状态总要清掉。 */
export async function postLogout(): Promise<void> {
  const response = await call('/logout', { method: 'POST' });
  if (!isFailure(response)) await response.body?.cancel().catch(() => undefined);
}
