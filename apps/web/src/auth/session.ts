/**
 * 全站唯一的「当前登录状态」。
 *
 * 三态而不是「用户 or null」：`unknown` 表示**还没问过后端**。这个状态是必须的——
 * `main.ts` 的纪律是「同步挂出首个视图」，而查会话是异步的；没有 unknown，首帧就只能
 * 先猜一个，猜错就会闪一下（先显示「登录/注册」再变成头像）。
 *
 * 为什么不做 localStorage 镜像：会话真源是 HttpOnly cookie，JS 读不到也不该读。
 * 缓存一份「上次是谁」只会带来更难查的错态（退登后另一个标签页还顶着头像）。
 */

import {
  fetchSession,
  postLogin,
  postLogout,
  postRegister,
  type AuthResult,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from './api';

export type AuthState =
  | { readonly status: 'unknown' }
  | { readonly status: 'guest' }
  | { readonly status: 'user'; readonly user: PublicUser };

let state: AuthState = { status: 'unknown' };
const listeners = new Set<(next: AuthState) => void>();

function emit(): void {
  // 复制一份再遍历：监听器里可能会取消订阅（例如页面销毁）。
  for (const listener of [...listeners]) listener(state);
}

function set(next: AuthState): void {
  state = next;
  emit();
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribe(listener: (next: AuthState) => void): () => void {
  listeners.add(listener);
  // 立即回调一次当前值：订阅方不必自己先 get 一遍、也不会漏掉中间态。
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

let inFlight: Promise<AuthState> | null = null;

/**
 * 问一次后端「我是谁」。
 *
 * 并发去重：`navbar` 与登录页可能同时触发，只发一个请求。失败一律降级成游客——
 * 后端没起的时候站点仍然要能看，只是不能登录。
 */
export function hydrate(): Promise<AuthState> {
  inFlight ??= (async () => {
    const result = await fetchSession();
    set(result.ok && result.user ? { status: 'user', user: result.user } : { status: 'guest' });
    return state;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 截图 / 预览模式用：不碰网络，直接落成确定的游客态。 */
export function markGuest(): void {
  set({ status: 'guest' });
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const result = await postLogin(input);
  if (result.ok) set({ status: 'user', user: result.user });
  return result;
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  // 后端注册成功即签发 cookie，所以这里同样直接进登录态，不必再走一次登录。
  const result = await postRegister(input);
  if (result.ok) set({ status: 'user', user: result.user });
  return result;
}

export async function logout(): Promise<void> {
  await postLogout();
  // 不论请求成败都清本地状态：cookie 清理失败时至少界面不再假装还登着。
  set({ status: 'guest' });
}

/**
 * 局部更新当前用户（改昵称 / 换头像之后由设置页调用）。
 *
 * 为什么需要它：导航栏与页面头部读的是同一份 `PublicUser`。没有局部更新就只能
 * 再 `hydrate()` 往返一次，中间会闪一帧旧头像；而且在弱网下「保存成功但头像没变」
 * 的观感很差。
 *
 * `id` 对不上就整条忽略：防止某个异步响应回来时已经换了账号，把上一个号的头像
 * 贴到新账号上。
 */
export function applyUser(patch: Partial<PublicUser> & { id?: string }): void {
  if (state.status !== 'user') return;
  if (patch.id !== undefined && patch.id !== state.user.id) return;
  set({ status: 'user', user: { ...state.user, ...patch } });
}

/* ---------------------------------------------------------------------------
   登录后的落点
--------------------------------------------------------------------------- */

let returnTo: string | null = null;

/**
 * 记住「从哪一页点的登录」。
 *
 * 由 `account-entry` 在点击「登录 / 注册」时调用，也用于账号页的「去登录」按钮——
 * 那时 `location.hash` 还是原页面，一旦哈希变成 `#login` 就再也拿不回来了。
 * 登录页本身不记（否则登录成功又被弹回登录页）。
 */
export function rememberReturnTo(hash: string): void {
  if (!hash || hash === '#login' || hash.startsWith('#login/')) return;
  returnTo = hash;
}

/** 取一次并清空：同一个落点只用一次，否则下次登录会莫名其妙跳回上一次的位置。 */
export function takeReturnTo(fallback = '#home'): string {
  const value = returnTo ?? fallback;
  returnTo = null;
  return value;
}

/* ---------------------------------------------------------------------------
   多标签页同步
--------------------------------------------------------------------------- */

let lastSync = 0;

/**
 * 切回前台时悄悄核对一次。
 *
 * 场景：A 标签页退出登录，B 标签页还顶着头像。30 秒的节流是为了避免
 * 频繁切窗口时反复打接口。
 */
export function startAuthSync(): () => void {
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (state.status === 'unknown') return;
    const now = Date.now();
    if (now - lastSync < 30_000) return;
    lastSync = now;
    void hydrate();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
  };
}
