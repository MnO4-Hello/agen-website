/**
 * `/api/works` 的窄客户端。
 *
 * 与 `admin/api.ts` 同一套原则：**页面只认这里的类型**，`fetch` 的细节不外泄。
 * 但这里用的是相对路径 `/api/works`（公开接口，不需要 cookie），并且**永不抛异常**——
 * 调用方拿到的永远是一个可判定的结果对象。
 *
 * 为什么强调「不抛」：作品页与首页作品墙都是「数据没来 / 接口挂了也要能看」的场景。
 * 首页尤其如此——整条滚动叙事是站点的主视觉，不能因为后端没起就白屏。
 */

export type WorkMode = 'template' | 'developer';

/** 列表项：够画一张卡，不含正文。 */
export interface WorkSummary {
  slug: string;
  mode: WorkMode;
  title: string;
  summary: string;
  tags: string[];
  year: string;
  category: string;
  thumbnail: string;
  order: number;
  updatedAt: string;
}

/** 详情：在摘要之上补正文与外链。 */
export interface WorkDetail extends WorkSummary {
  repoUrl: string;
  demoUrl: string;
  gallery: string[];
  /** 模板模式的 Markdown（另一种模式恒为空串）。 */
  readme: string;
  /** 开发者模式的整页 HTML（另一种模式恒为空串）。 */
  html: string;
}

/** 详情读取的三种结局。`error.message` 为空串表示「被主动取消」，不必提示用户。 */
export type WorkDetailResult =
  | { kind: 'ok'; work: WorkDetail }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** 列表读取的结果：失败也带空数组，页面统一走「空态 + 可重试」。 */
export interface WorksResult {
  works: WorkSummary[];
  /** `null` = 成功；有值 = 一句能直接显示的话。 */
  error: string | null;
}

/** 超时：后端在本机，6 秒还没回基本就是没起。 */
const TIMEOUT_MS = 6000;

/**
 * 组合「调用方的取消」与「本函数的超时」。
 *
 * 不用 `AbortSignal.any()`：那是较新的 API，jsdom 与旧浏览器都没有，而这个模块会被
 * 回归测试直接 import。手写一个 controller 转发成本很低。
 */
function withTimeout(signal: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  const forward = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 只做形状检查：字段缺失时给安全默认值，避免页面到处写 `?? ''`。 */
function toSummary(raw: unknown): WorkSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.slug !== 'string' || typeof value.title !== 'string') return null;
  return {
    slug: value.slug,
    mode: value.mode === 'developer' ? 'developer' : 'template',
    title: value.title,
    summary: typeof value.summary === 'string' ? value.summary : '',
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    year: typeof value.year === 'string' ? value.year : '',
    category: typeof value.category === 'string' ? value.category : '',
    thumbnail: typeof value.thumbnail === 'string' ? value.thumbnail : '',
    order: typeof value.order === 'number' ? value.order : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function toDetail(raw: unknown): WorkDetail | null {
  const base = toSummary(raw);
  if (!base) return null;
  const value = raw as Record<string, unknown>;
  return {
    ...base,
    repoUrl: typeof value.repoUrl === 'string' ? value.repoUrl : '',
    demoUrl: typeof value.demoUrl === 'string' ? value.demoUrl : '',
    gallery: Array.isArray(value.gallery)
      ? value.gallery.filter((item): item is string => typeof item === 'string')
      : [],
    readme: typeof value.readme === 'string' ? value.readme : '',
    html: typeof value.html === 'string' ? value.html : '',
  };
}

export async function fetchWorks(signal?: AbortSignal): Promise<WorksResult> {
  const guard = withTimeout(signal);
  try {
    const response = await fetch('/api/works', {
      signal: guard.signal,
      headers: { accept: 'application/json' },
      // 后台刚改完就要能看到，别让浏览器拿缓存。
      cache: 'no-store',
    });
    if (!response.ok) {
      return { works: [], error: `读取作品列表失败（HTTP ${response.status}）。` };
    }
    const data = (await response.json().catch(() => null)) as { works?: unknown } | null;
    const list = Array.isArray(data?.works) ? data.works : [];
    const works = list.map(toSummary).filter((item): item is WorkSummary => item !== null);
    return { works, error: null };
  } catch (error) {
    if (isAbort(error) && signal?.aborted) return { works: [], error: null };
    return { works: [], error: '连不上后端服务，请确认 apps/api 已经启动。' };
  } finally {
    guard.done();
  }
}

export async function fetchWork(slug: string, signal?: AbortSignal): Promise<WorkDetailResult> {
  const guard = withTimeout(signal);
  try {
    const response = await fetch(`/api/works/${encodeURIComponent(slug)}`, {
      signal: guard.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return { kind: 'error', message: `读取作品失败（HTTP ${response.status}）。` };
    const data = (await response.json().catch(() => null)) as { work?: unknown } | null;
    const work = data?.work === undefined ? null : toDetail(data.work);
    return work ? { kind: 'ok', work } : { kind: 'missing' };
  } catch (error) {
    if (isAbort(error) && signal?.aborted) return { kind: 'error', message: '' };
    return { kind: 'error', message: '连不上后端服务，请确认 apps/api 已经启动。' };
  } finally {
    guard.done();
  }
}

/** 详情页地址。集中在这里，免得各处各写一遍模板字符串写歪。 */
export function workHref(slug: string): string {
  return `#works/${encodeURIComponent(slug)}`;
}
