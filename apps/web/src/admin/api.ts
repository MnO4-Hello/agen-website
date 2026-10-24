/**
 * `/api/admin/*` 的窄客户端。
 *
 * 原则：**页面只认这里的返回类型**，不去碰 `fetch` 的细节。这样后端换响应结构时只需要改
 * 这一个文件；也让「401 该干什么」只有一处实现（见 `request()` 里的 `admin:unauthorized`）。
 *
 * `credentials: 'same-origin'` 是必须的：会话是 **HttpOnly cookie**，JS 读不到它，
 * 只能让浏览器自己带上。同理，前端**不保存任何 token**——没有 localStorage 可偷。
 */

/** 请求都带上同源凭据，且不许缓存（这些响应里含「是否已登录」与实时数据）。 */
const REQUEST_INIT: RequestInit = {
  credentials: 'same-origin',
  cache: 'no-store',
};

export interface SessionState {
  authenticated: boolean;
  user?: string;
}

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
    return { ok: false, status: 401, message: '会话已过期，请重新登录。' };
  }
  if (response.status === 503) {
    return {
      ok: false,
      status: 503,
      message:
        '管理接口还没配置好：请在仓库根目录的 .env 里填上 ADMIN_USER、ADMIN_PASSWORD、ADMIN_SESSION_SECRET，然后重启后端。',
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
        '登录还没配置好：请在仓库根目录的 .env 里填上 ADMIN_USER、ADMIN_PASSWORD、ADMIN_SESSION_SECRET，然后重启后端。',
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
  /** `open` = 连上了（含自动重连成功）；`error` = 断了，浏览器会在 3 秒后自己重试。 */
  onState: (state: 'open' | 'error') => void;
}

/**
 * 打开 SSE 日志流，返回关闭函数。
 *
 * `EventSource` 会自动重连（服务端首包写了 `retry: 3000`），所以这里不自己做重连；
 * 断档由调用方在 `onState('open')` 时用 `fetchLogs(after)` 补齐。
 */
export function openLogStream(after: number, handlers: LogStreamHandlers): () => void {
  const source = new EventSource(`/api/admin/console/stream?after=${after}`);

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

  source.onopen = () => handlers.onState('open');
  source.onerror = () => handlers.onState('error');

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
