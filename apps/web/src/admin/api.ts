/**
 * `/api/admin/*` 的窄客户端。
 *
 * 原则：**页面只认这里的返回类型**，不去碰 `fetch` 的细节。这样后端换响应结构时只需要改
 * 这一个文件；也让「401 该干什么」只有一处实现（见 `request()` 里的 `admin:unauthorized`）。
 *
 * `credentials: 'same-origin'` 是必须的：会话是 **HttpOnly cookie**，JS 读不到它，
 * 只能让浏览器自己带上。同理，前端**不保存任何 token**——没有 localStorage 可偷。
 */

import type { SiteFeature, SiteMode } from '../site/config';

/** 请求都带上同源凭据，且不许缓存（这些响应里含「是否已登录」与实时数据）。 */
const REQUEST_INIT: RequestInit = {
  credentials: 'same-origin',
  cache: 'no-store',
};

export interface SessionState {
  authenticated: boolean;
  user?: string;
  /**
   * 后台身份档位。`owner` 站长 / `admin` 管理员。
   *
   * 左侧导航靠它决定显示哪些分区：管理员看不到「作品」与「徽章」（那是内容生产）。
   * 未登录时不带这个字段，所以是可选的。
   */
  role?: AdminRole;
  /** `.env` 管理员（最高权，没有对应账号记录）还是账号登录。 */
  source?: 'env' | 'account';
}

export type AdminRole = 'owner' | 'admin';

/** 登录失败的原因。`null` 返回（网络层失败）也算一种原因。 */
export type LoginFailureKind =
  | 'credentials'
  | 'throttled'
  | 'not-configured'
  | 'bad-request'
  | 'offline'
  | 'unknown';

export type LoginResult = { ok: true; user: string } | { ok: false; kind: LoginFailureKind; message: string };

/** 通用结果：失败时带 HTTP 状态码（0 = 网络层没通）和一句能直接显示的话。 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/** 网络层兜底：`fetch` 本身 reject（后端没起、断网、被拦）时返回 null。 */
async function call(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`/api/admin${path}`, { ...REQUEST_INIT, ...init });
  } catch {
    return null;
  }
}

/** 会话过期时广播给 `main.ts`，由它切回登录页——各个视图不用各自处理登录态。 */
const UNAUTHORIZED_EVENT = 'admin:unauthorized';

function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

/** 把错误响应读成一句人话；后端有 `message` 就用它。 */
async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { message?: unknown } | null;
  if (data && typeof data.message === 'string' && data.message) return data.message;
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await call(path, init);
  if (!response) {
    return { ok: false, status: 0, message: '连不上后端服务，请确认 apps/api 已经启动。' };
  }
  if (response.ok) {
    const data = (await response.json().catch(() => null)) as T | null;
    if (data === null) return { ok: false, status: response.status, message: '后端返回了空响应。' };
    return { ok: true, data };
  }
  if (response.status === 401) {
    notifyUnauthorized();
    /*
     * `admin_revoked` = 会话本身还没过期，但这个人的后台权限被改掉了（被降级、被停用、
     * 账号被删）。跟「没登录」区分开：前者要告诉他发生了什么，否则他会以为自己按错了。
     */
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const revoked = data?.error === 'admin_revoked';
    return {
      ok: false,
      status: 401,
      message: revoked ? '你的后台权限已变更，请重新登录。' : '会话已过期，请重新登录。',
    };
  }
  if (response.status === 503) {
    return {
      ok: false,
      status: 503,
      message:
        '管理接口还没配置好：请在仓库根目录的 .env 里填上 ADMIN_SESSION_SECRET，然后重启后端。',
    };
  }
  if (response.status === 413) {
    return { ok: false, status: 413, message: '文件太大了，超过了接口允许的上限。' };
  }
  return { ok: false, status: response.status, message: await errorMessage(response, `请求失败（HTTP ${response.status}）。`) };
}

function jsonRequest<T>(path: string, body: unknown, method = 'POST'): Promise<ApiResult<T>> {
  return request<T>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function fetchSession(): Promise<SessionState | null> {
  const response = await call('/session');
  if (!response || !response.ok) return null;
  const data = (await response.json().catch(() => null)) as SessionState | null;
  return data && typeof data.authenticated === 'boolean' ? data : null;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await call('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!response) {
    return { ok: false, kind: 'offline', message: '连不上后端服务，请确认 apps/api 已经启动。' };
  }

  if (response.ok) {
    const data = (await response.json().catch(() => null)) as SessionState | null;
    return { ok: true, user: data?.user ?? username };
  }

  if (response.status === 401) {
    return { ok: false, kind: 'credentials', message: '用户名或密码不对。' };
  }
  if (response.status === 429) {
    const data = (await response.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
    const seconds = data?.retryAfterSeconds ?? 0;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return { ok: false, kind: 'throttled', message: `尝试次数太多，请约 ${minutes} 分钟后再试。` };
  }
  if (response.status === 503) {
    return {
      ok: false,
      kind: 'not-configured',
      message:
        '登录还没配置好：请在仓库根目录的 .env 里填上 ADMIN_SESSION_SECRET，然后重启后端。',
    };
  }
  if (response.status === 400) {
    return { ok: false, kind: 'bad-request', message: '请求格式不对，刷新页面再试一次。' };
  }
  return { ok: false, kind: 'unknown', message: `登录失败（HTTP ${response.status}）。` };
}

export async function logout(): Promise<void> {
  await call('/logout', { method: 'POST' });
}

/* ---------------------------------------------------------------------------
   控制台
--------------------------------------------------------------------------- */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ServerStats {
  pid: number;
  node: string;
  platform: string;
  startedAt: number;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  logCount: number;
}

export interface LogSnapshot {
  logs: LogEntry[];
  stats: ServerStats;
}

/** 首屏 / 重连补断档：`after` 只要比已知的最大 id 大，就不会重复。 */
export function fetchLogs(after = 0, limit = 500): Promise<ApiResult<LogSnapshot>> {
  return request<LogSnapshot>(`/console/logs?after=${after}&limit=${limit}`);
}

export function clearServerLogs(): Promise<ApiResult<{ ok: boolean; stats: ServerStats }>> {
  return request<{ ok: boolean; stats: ServerStats }>('/console/clear', { method: 'POST' });
}

export interface LogStreamHandlers {
  onLog: (entry: LogEntry) => void;
  onStats: (stats: ServerStats) => void;
  /**
   * `open` = 连上了（含自动重连成功）；`error` = 断了，浏览器会在 3 秒后自己重试；
   * `revoked` = 连续 5 次都连不上，已经**主动停掉**重连（通常是权限被撤）。
   */
  onState: (state: 'open' | 'error' | 'revoked') => void;
}

/**
 * SSE 连续失败多少次就放弃重连。5 × 3 秒 ≈ 15 秒，正常人等得起，
 * 而被撤权的人也不会一直敲门。
 */
const MAX_STREAM_FAILURES = 5;

/**
 * 打开 SSE 日志流，返回关闭函数。
 *
 * `EventSource` 会自动重连（服务端首包写了 `retry: 3000`），所以这里不自己做重连；
 * 断档由调用方在 `onState('open')` 时用 `fetchLogs(after)` 补齐。
 */
export function openLogStream(after: number, handlers: LogStreamHandlers): () => void {
  const source = new EventSource(`/api/admin/console/stream?after=${after}`);
  let failures = 0;

  source.addEventListener('log', (event) => {
    try {
      handlers.onLog(JSON.parse((event as MessageEvent<string>).data) as LogEntry);
    } catch {
      // 单条坏数据丢掉即可，不要拆掉整条连接。
    }
  });
  source.addEventListener('stats', (event) => {
    try {
      handlers.onStats(JSON.parse((event as MessageEvent<string>).data) as ServerStats);
    } catch {
      /* ignore */
    }
  });

  source.onopen = () => {
    failures = 0;
    handlers.onState('open');
  };
  source.onerror = () => {
    failures += 1;
    /*
     * 连续 5 次都没连上就停掉。
     *
     * 典型场景：这个人的后台权限被撤了（被封/被降级），SSE 每 3 秒重连一次、
     * 每次都吃 401，控制台会一直闪「重连中…」。停掉并交给 UI 说一句
     * 「需要重新登录」，比无限敲门诚实。
     */
    if (failures >= MAX_STREAM_FAILURES) {
      source.close();
      handlers.onState('revoked');
      return;
    }
    handlers.onState('error');
  };

  return () => source.close();
}

/* ---------------------------------------------------------------------------
   文件管理
--------------------------------------------------------------------------- */

export interface FileRoot {
  path: string;
  label: string;
  exists: boolean;
}

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';
export type PreviewKind = 'text' | 'image' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
  mime: string | null;
  preview: PreviewKind;
}

export interface FileListing {
  root: string;
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface FileContent {
  root: string;
  path: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

export function fetchFileRoots(): Promise<ApiResult<{ roots: FileRoot[] }>> {
  return request<{ roots: FileRoot[] }>('/files/roots');
}

export function listFiles(root: string, path: string): Promise<ApiResult<FileListing>> {
  return request<FileListing>(`/files/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
}

export function readFileContent(root: string, path: string): Promise<ApiResult<FileContent>> {
  return request<FileContent>(`/files/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
}

export function saveFileContent(
  root: string,
  path: string,
  content: string,
): Promise<ApiResult<{ ok: boolean; size: number; mtime: number }>> {
  return jsonRequest('/files/save', { root, path, content });
}

export function uploadFile(
  root: string,
  path: string,
  file: File,
  overwrite = false,
): Promise<ApiResult<{ ok: boolean; path: string; size: number; mtime: number }>> {
  const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(
    file.name,
  )}${overwrite ? '&overwrite=1' : ''}`;
  return request(`/files/upload?${query}`, {
    method: 'POST',
    // 必须显式写死：File 自带 `type: image/png` 的话，后端只注册了 octet-stream 的解析器。
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
}

export function createFolder(root: string, path: string, name: string): Promise<ApiResult<{ ok: boolean; path: string }>> {
  return jsonRequest('/files/mkdir', { root, path, name });
}

export function renameEntry(root: string, path: string, name: string): Promise<ApiResult<{ ok: boolean; path: string }>> {
  return jsonRequest('/files/rename', { root, path, name });
}

export function removeEntry(
  root: string,
  path: string,
): Promise<ApiResult<{ ok: boolean; trashedTo: string; message: string }>> {
  return jsonRequest('/files/remove', { root, path });
}

/** 图片预览 / 下载用的直链（浏览器直接请求，自动带 cookie）。 */
export function rawFileUrl(root: string, path: string, download = false): string {
  const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  return `/api/admin/files/raw?${query}`;
}

/* ---------------------------------------------------------------------------
   作品
--------------------------------------------------------------------------- */

export type WorkMode = 'template' | 'developer';

/**
 * 后台视角的完整记录。
 *
 * 与公开接口的 `WorkSummary/WorkDetail` 的区别：这里**有** `id`、`published`、`order`。
 * 管理端永远拿全量，编辑时不用再判断「这个字段是不是没下发」。
 */
export interface AdminWork {
  id: string;
  slug: string;
  mode: WorkMode;
  title: string;
  summary: string;
  tags: string[];
  year: string;
  category: string;
  repoUrl: string;
  demoUrl: string;
  thumbnail: string;
  gallery: string[];
  readme: string;
  html: string;
  published: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 提交给后端的形状。
 *
 * 保存时**总是发送整份草稿**（而不是只发改动过的字段）：后端按 `parseWorkFields`
 * 做全量校验，少发一个字段就意味着「沿用旧值」，两边状态一旦不同步很难查。
 * 后端仍然支持局部更新（发布开关、排序就是这么用的）。
 */
export type WorkInput = Omit<AdminWork, 'id' | 'createdAt' | 'updatedAt'>;

export interface SavedMedia {
  file: string;
  url: string;
  size: number;
  mime: string;
}

export function fetchAdminWorks(): Promise<ApiResult<{ works: AdminWork[] }>> {
  return request<{ works: AdminWork[] }>('/works');
}

export function createWork(input: WorkInput): Promise<ApiResult<{ work: AdminWork }>> {
  return jsonRequest<{ work: AdminWork }>('/works', input);
}

export function updateWork(id: string, input: WorkInput): Promise<ApiResult<{ work: AdminWork }>> {
  return jsonRequest<{ work: AdminWork }>(`/works/${encodeURIComponent(id)}`, input, 'PUT');
}

export function deleteWork(id: string): Promise<ApiResult<{ ok: boolean; trashedTo: string | null }>> {
  return request<{ ok: boolean; trashedTo: string | null }>(`/works/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function setWorkPublished(id: string, published: boolean): Promise<ApiResult<{ work: AdminWork }>> {
  return jsonRequest<{ work: AdminWork }>(`/works/${encodeURIComponent(id)}/publish`, { published });
}

export function reorderWorks(ids: string[]): Promise<ApiResult<{ works: AdminWork[] }>> {
  return jsonRequest<{ works: AdminWork[] }>('/works/reorder', { ids });
}

/**
 * 上传一张作品图片（缩略图 / 图集）。
 *
 * `content-type` 必须写死 `application/octet-stream`：`File` 自带 `image/png`
 * 之类，而后端只给 octet-stream 注册了解析器，不写会 415（与文件管理同一个坑）。
 */
export function uploadWorkMedia(file: File): Promise<ApiResult<SavedMedia>> {
  return request<SavedMedia>(`/works/media?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
}

/* ---------------------------------------------------------------------------
   帖子（管理后台的「内容」）
--------------------------------------------------------------------------- */

export type AdminPostStatus = 'draft' | 'published';
export type AdminReplyStatus = 'visible' | 'hidden';

export interface AdminAuthor {
  kind: 'admin' | 'user' | 'guest';
  id: string;
  nickname: string;
  avatarUrl: string;
}

/**
 * 后台视角的帖子。
 *
 * 后端刻意**不发 `replies` 与 `votes`**（一个可能几百条，一个是「userId → 票」的大对象），
 * 只发算好的 `up / down / score / replyCount`。编辑器不需要这些东西。
 */
export interface AdminPost {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  /** 后端 `editorView` 是 `{...record}`，会原样带出来；空串 = 没有封面。 */
  coverImage: string;
  categoryId: string;
  tags: string[];
  author: AdminAuthor;
  status: AdminPostStatus;
  locked: boolean;
  up: number;
  down: number;
  score: number;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/**
 * 提交给后端的形状。
 *
 * 与作品一样**每次发整份草稿**：少发一个字段等于「沿用旧值」，两边状态不同步时很难查。
 * `slug` 传空串 = 按标题重新生成。
 */
export interface AdminPostInput {
  title: string;
  markdown: string;
  /** 空串 = 清掉封面。每次传整份草稿，所以「不传」不会被当成「不改」。 */
  coverImage: string;
  categoryId: string;
  tags: string[];
  status: AdminPostStatus;
  locked: boolean;
  authorName: string;
  slug?: string;
}

export interface AdminCategory {
  id: string;
  name: string;
  key: string;
  order: number;
  count: number;
}

export interface AdminReply {
  id: string;
  floor: number;
  author: AdminAuthor & { deleted?: boolean; owner?: boolean };
  body: string;
  replyToFloor: number | null;
  replyToName: string;
  score: number;
  up: number;
  down: number;
  status: AdminReplyStatus;
  createdAt: string;
}

export interface BlogMeta {
  author: { nickname: string; avatarUrl: string };
  categories: AdminCategory[];
}

/**
 * 上传一张帖子插图。
 *
 * `content-type` 必须写死 `application/octet-stream`：`File` 自带 `image/png` 之类，
 * 而后端只给 octet-stream 注册了解析器，不写会 415（与作品/文件管理同一个坑）。
 */
export function uploadBlogMedia(file: File): Promise<ApiResult<SavedMedia>> {
  return request<SavedMedia>('/blog/media', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
}

export function fetchBlogMeta(): Promise<ApiResult<BlogMeta>> {
  return request<BlogMeta>('/blog/meta');
}

export function fetchAdminPosts(query: { q?: string; status?: string; cat?: string } = {}): Promise<
  ApiResult<{ posts: AdminPost[] }>
> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.cat) params.set('cat', query.cat);
  const suffix = params.toString();
  return request<{ posts: AdminPost[] }>(`/blog/posts${suffix ? `?${suffix}` : ''}`);
}

export function fetchAdminPost(id: string): Promise<ApiResult<{ post: AdminPost }>> {
  return request<{ post: AdminPost }>(`/blog/posts/${encodeURIComponent(id)}`);
}

export function createAdminPost(input: AdminPostInput): Promise<ApiResult<{ post: AdminPost }>> {
  return jsonRequest<{ post: AdminPost }>('/blog/posts', input);
}

export function updateAdminPost(id: string, input: AdminPostInput): Promise<ApiResult<{ post: AdminPost }>> {
  return jsonRequest<{ post: AdminPost }>(`/blog/posts/${encodeURIComponent(id)}`, input, 'PUT');
}

export function setAdminPostStatus(
  id: string,
  status: AdminPostStatus,
): Promise<ApiResult<{ post: AdminPost }>> {
  return jsonRequest<{ post: AdminPost }>(`/blog/posts/${encodeURIComponent(id)}/status`, { status });
}

export function deleteAdminPost(
  id: string,
): Promise<ApiResult<{ ok: boolean; removedReplies: number }>> {
  return request<{ ok: boolean; removedReplies: number }>(`/blog/posts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function fetchAdminReplies(
  postId: string,
  cursor = '',
): Promise<ApiResult<{ replies: AdminReply[]; nextCursor: string | null }>> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  const suffix = params.toString();
  return request<{ replies: AdminReply[]; nextCursor: string | null }>(
    `/blog/posts/${encodeURIComponent(postId)}/replies${suffix ? `?${suffix}` : ''}`,
  );
}

export function setAdminReplyStatus(
  id: string,
  status: AdminReplyStatus,
): Promise<ApiResult<{ reply: AdminReply }>> {
  return jsonRequest<{ reply: AdminReply }>(`/blog/replies/${encodeURIComponent(id)}/status`, { status });
}

export function fetchAdminCategories(): Promise<ApiResult<{ categories: AdminCategory[] }>> {
  return request<{ categories: AdminCategory[] }>('/blog/categories');
}

export function createAdminCategory(name: string): Promise<ApiResult<{ category: AdminCategory }>> {
  return jsonRequest<{ category: AdminCategory }>('/blog/categories', { name });
}

export function updateAdminCategory(
  id: string,
  name: string,
): Promise<ApiResult<{ category: AdminCategory }>> {
  return jsonRequest<{ category: AdminCategory }>(`/blog/categories/${encodeURIComponent(id)}`, { name }, 'PUT');
}

export function deleteAdminCategory(id: string): Promise<ApiResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>(`/blog/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function reorderAdminCategories(ids: string[]): Promise<ApiResult<{ categories: AdminCategory[] }>> {
  return jsonRequest<{ categories: AdminCategory[] }>('/blog/categories/reorder', { ids });
}

/* ---------------------------------------------------------------------------
   留言（guestbook）
--------------------------------------------------------------------------- */

export type AdminMessageStatus = 'visible' | 'hidden';
export type AdminMessageMode = 'text' | 'markdown';

export interface AdminMessageAuthor {
  kind: 'guest' | 'user' | 'admin';
  id: string;
  nickname: string;
  avatarUrl: string;
  deleted: boolean;
  owner: boolean;
}

export interface AdminMessage {
  id: string;
  floor: number | null;
  author: AdminMessageAuthor;
  mode: AdminMessageMode;
  body: string;
  images: string[];
  status: AdminMessageStatus;
  createdAt: string;
  replies: AdminMessage[];
  replyCount: number;
}

export interface AdminMessagePage {
  messages: AdminMessage[];
  nextCursor: string | null;
  total: number;
}

/** 后台看的是**全部**留言（含已隐藏、含隐藏回复的正文），按楼层号降序。 */
export function fetchAdminMessages(
  query: { status?: string; q?: string; cursor?: string } = {},
): Promise<ApiResult<AdminMessagePage>> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', '20');
  return request<AdminMessagePage>(`/messages?${params.toString()}`);
}

/**
 * 隐藏 / 恢复。
 *
 * **只做软删，没有硬删。** 留言底下的回复、以及别人对它的引用都靠「留下这条记录」才
 * 成立；真删了就是一片查不出来的空洞。可逆操作，所以不弹确认框。
 */
export function setAdminMessageStatus(
  id: string,
  status: AdminMessageStatus,
): Promise<ApiResult<{ message: AdminMessage }>> {
  return jsonRequest<{ message: AdminMessage }>(
    `/messages/${encodeURIComponent(id)}/status`,
    { status },
  );
}

/** 以站长身份回复（作者快照由服务端按站内 owner 账号生成，前端管不着）。 */
export function replyAsAdmin(
  id: string,
  body: string,
): Promise<ApiResult<{ reply: AdminMessage; replyCount: number }>> {
  return jsonRequest<{ reply: AdminMessage; replyCount: number }>(
    `/messages/${encodeURIComponent(id)}/replies`,
    { body },
  );
}

/* ---------------------------------------------------------------------------
   账户与徽章
---------------------------------------------------------------------------

   `AdminAccount` 是后台唯一的账号形状。它与前台的 `PublicUser` 刻意不同：
   后台要看到邮箱、注册时间、处罚记录和「能对这个人做什么」，前台一样都不该有。
   所以两边是两个类型，不要试图合并。
*/

export type AccountRole = 'user' | 'admin' | 'owner';

/** 处罚记录。`until === null` = 永久；`active` 由服务端按当前时间算好。 */
export interface AccountSanction {
  until: string | null;
  reason: string;
  by: string;
  bySource: 'env' | 'account';
  at: string;
  /** 还在生效？过期的记录仍然返回（那是审计线索），只是 `active: false`。 */
  active: boolean;
}

/** 站长授予的徽章（与前台同名类型对应，但这里是后台视图）。 */
export interface AdminGrantedBadge {
  badgeId: string;
  label: string;
  color: string;
  emoji: string;
  hint: string;
  grantedAt: string;
  /** 目录项已下架：徽章仍在他身上，但不能再授给别人。 */
  archived: boolean;
}

/** 服务端算好的能力位。前端**不要**自己推导，只用来 `disabled` + `title`。 */
export interface AdminAccountCaps {
  role: boolean;
  ban: boolean;
  mute: boolean;
  grantBadge: boolean;
  grantOwner: boolean;
  revokeBadge: boolean;
}

export interface AdminAccount {
  id: string;
  username: string;
  nickname: string;
  email: string;
  role: AccountRole;
  legacyDisabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  ban: AccountSanction | null;
  mute: AccountSanction | null;
  grantedBadges: AdminGrantedBadge[];
  can: AdminAccountCaps;
}

export interface AdminAccountCounts {
  total: number;
  owners: number;
  admins: number;
  banned: number;
  muted: number;
}

export interface AdminAccountPage {
  accounts: AdminAccount[];
  total: number;
  page: number;
  size: number;
  counts: AdminAccountCounts;
}

export interface AdminBadge {
  id: string;
  label: string;
  color: string;
  emoji: string;
  hint: string;
  order: number;
  createdAt: string;
  createdBy: string;
  archivedAt: string | null;
  grantCount: number;
}

export interface AdminBadgeCatalog {
  badges: AdminBadge[];
  archived: AdminBadge[];
}

export interface AdminAccountQuery {
  q?: string;
  role?: AccountRole | 'all';
  state?: 'all' | 'active' | 'banned' | 'muted' | 'disabled';
  page?: number;
  size?: number;
}

export function fetchAdminAccounts(query: AdminAccountQuery = {}): Promise<ApiResult<AdminAccountPage>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.role && query.role !== 'all') params.set('role', query.role);
  if (query.state && query.state !== 'all') params.set('state', query.state);
  if (query.page) params.set('page', String(query.page));
  if (query.size) params.set('size', String(query.size));
  const suffix = params.toString();
  return request<AdminAccountPage>(`/accounts${suffix ? `?${suffix}` : ''}`);
}

export function fetchAdminAccount(id: string): Promise<ApiResult<{ account: AdminAccount }>> {
  return request<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}`);
}

export function setAccountRole(
  id: string,
  role: AccountRole,
): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}/role`, { role });
}

/** `days`：1 / 3 / 7 / 30，`0` = 永久。解封走 `unbanAccount`（同一个接口的 `lift`）。 */
export function banAccount(
  id: string,
  days: number,
  reason: string,
): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}/ban`, {
    days,
    reason,
  });
}

export function unbanAccount(id: string): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}/ban`, {
    lift: true,
  });
}

export function muteAccount(
  id: string,
  days: number,
  reason: string,
): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}/mute`, {
    days,
    reason,
  });
}

export function unmuteAccount(id: string): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(`/accounts/${encodeURIComponent(id)}/mute`, {
    lift: true,
  });
}

export function fetchAdminBadges(): Promise<ApiResult<AdminBadgeCatalog>> {
  return request<AdminBadgeCatalog>('/badges');
}

export interface BadgeDraft {
  label: string;
  color: string;
  emoji: string;
  hint: string;
}

export function createAdminBadge(
  draft: BadgeDraft,
): Promise<ApiResult<{ badge: AdminBadge }>> {
  return jsonRequest<{ badge: AdminBadge }>('/badges', draft);
}

export function updateAdminBadge(
  id: string,
  draft: BadgeDraft,
): Promise<ApiResult<{ badge: AdminBadge }>> {
  return jsonRequest<{ badge: AdminBadge }>(`/badges/${encodeURIComponent(id)}`, draft, 'PUT');
}

/** 下架（软删）：已授予的人不会被收回，只是它不再出现在可授予列表里。 */
export function archiveAdminBadge(
  id: string,
): Promise<ApiResult<{ badge: AdminBadge; affectedGrants: number }>> {
  return request<{ badge: AdminBadge; affectedGrants: number }>(
    `/badges/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export function restoreAdminBadge(
  id: string,
): Promise<ApiResult<{ badge: AdminBadge; affectedGrants: number }>> {
  return jsonRequest<{ badge: AdminBadge; affectedGrants: number }>(
    `/badges/${encodeURIComponent(id)}/restore`,
    {},
  );
}

export function grantAdminBadge(
  userId: string,
  badgeId: string,
): Promise<ApiResult<{ account: AdminAccount }>> {
  return jsonRequest<{ account: AdminAccount }>(
    `/accounts/${encodeURIComponent(userId)}/badges`,
    { badgeId },
  );
}

export function revokeAdminBadge(
  userId: string,
  badgeId: string,
): Promise<ApiResult<{ account: AdminAccount }>> {
  return request<{ account: AdminAccount }>(
    `/accounts/${encodeURIComponent(userId)}/badges/${encodeURIComponent(badgeId)}`,
    { method: 'DELETE' },
  );
}

/* ───────────────────────────── 站点形态 ───────────────────────────── */

/**
 * 当前配置是从哪儿来的。
 *
 * · `file`     —— 后台切过，以 `apps/api/data/site-mode.json` 为准；
 * · `env`      —— 后台还没切过，用的是 `.env` 里的 `SITE_MODE`；
 * · `fallback` —— 存储文件读不出来，已回退到 `display`（`corrupt` 为真）。
 *
 * 后台必须把它显示出来：否则「`.env` 写着 display、点按钮没反应」会被当成 bug。
 */
export type SiteModeSource = 'env' | 'file' | 'fallback';

export interface SiteModeSnapshot {
  mode: SiteMode;
  features: Record<SiteFeature, boolean>;
  source: SiteModeSource;
  /** 环境变量里写的是什么。 */
  envMode: SiteMode;
  updatedAt: string | null;
  updatedBy: string | null;
  corrupt: boolean;
}

export function fetchSiteMode(): Promise<ApiResult<{ site: SiteModeSnapshot }>> {
  return request<{ site: SiteModeSnapshot }>('/settings/site-mode');
}

export function updateSiteMode(
  mode: SiteMode,
): Promise<ApiResult<{ site: SiteModeSnapshot; changed: boolean }>> {
  return jsonRequest<{ site: SiteModeSnapshot; changed: boolean }>(
    '/settings/site-mode',
    { mode },
    'PUT',
  );
}
