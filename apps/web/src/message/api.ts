/**
 * `/api/messages` 的窄客户端。
 *
 * 与 `blog/api.ts` 同一套原则：页面只认这里的类型、`fetch` 细节不外泄、函数
 * **永不抛异常**。两个留言板特有的地方：
 *
 *   1. **上传走裸二进制**（`application/octet-stream`）。`File` 自带 `image/png`，
 *      而后端只注册了 octet-stream 解析器——不写死这个头就会 415。原样照抄
 *      `admin/api.ts` 里博客图片上传的做法。
 *   2. **上传与发布是两次请求**。先传图拿文件名，发布时只回传 `name`，服务端按正则
 *      复核后自己拼前缀；客户端永远不告诉服务端「这张图放在哪个 URL」。
 */

import type {
  Challenge,
  ComposerSubmitInput,
  MessageCreated,
  MessagePage,
  ReplyCreated,
  UploadedMedia,
} from './types';

/** 统一失败形状。`status === 0` 表示连不上后端；`message === ''` 表示被主动取消。 */
export interface MessageFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  retryAfterSeconds: number | null;
}

export type Outcome<T> = { ok: true; data: T } | MessageFailure;

const TIMEOUT_MS = 8000;

function timeout(signal: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
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

function networkFailure(): MessageFailure {
  return {
    ok: false,
    status: 0,
    error: 'network',
    message: '连不上后端服务，请确认 apps/api 已经启动。',
    retryAfterSeconds: null,
  };
}

function abortedFailure(): MessageFailure {
  return { ok: false, status: 0, error: 'aborted', message: '', retryAfterSeconds: null };
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Outcome<T>> {
  const guard = timeout(signal);
  try {
    const response = await fetch(path, {
      ...init,
      signal: guard.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });

    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      retryAfterSeconds?: unknown;
    } | null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof payload?.error === 'string' ? payload.error : `http_${response.status}`,
        message:
          typeof payload?.message === 'string' && payload.message
            ? payload.message
            : `请求失败（HTTP ${response.status}）。`,
        retryAfterSeconds:
          typeof payload?.retryAfterSeconds === 'number' ? payload.retryAfterSeconds : null,
      };
    }

    return { ok: true, data: payload as T };
  } catch (error) {
    if (isAbort(error)) return signal?.aborted ? abortedFailure() : networkFailure();
    return networkFailure();
  } finally {
    guard.done();
  }
}

/* ---------------------------------------------------------------------------
   读
--------------------------------------------------------------------------- */

/** 一页留言。`cursor` 为空串 = 第一页（最新的那些）。 */
export function fetchMessages(cursor: string, signal?: AbortSignal): Promise<Outcome<MessagePage>> {
  const query = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
  return request<MessagePage>(`/api/messages${query}`, {}, signal);
}

/** 领一道工作量证明题（游客才需要）。失败返回 `null`，调用方按「验证没完成」处理。 */
export async function requestCaptcha(): Promise<Challenge | null> {
  const result = await request<Challenge>('/api/messages/captcha');
  return result.ok ? result.data : null;
}

/* ---------------------------------------------------------------------------
   写
--------------------------------------------------------------------------- */

export function postMessage(input: ComposerSubmitInput): Promise<Outcome<MessageCreated>> {
  return request<MessageCreated>('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: input.mode,
      body: input.body,
      images: input.images,
      captcha: input.captcha,
      website: input.honeypot,
    }),
  });
}

export function postReply(
  parentId: string,
  input: ComposerSubmitInput,
): Promise<Outcome<ReplyCreated>> {
  return request<ReplyCreated>(`/api/messages/${encodeURIComponent(parentId)}/replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: input.body,
      images: input.images,
      captcha: input.captcha,
      website: input.honeypot,
    }),
  });
}

/**
 * 上传一张图。
 *
 * `content-type` 必须写死 `application/octet-stream`：`File` 自带 `image/png`，而后端
 * 只注册了 octet-stream 的解析器（5 MB 上限在同一处）。
 */
export function uploadImage(blob: Blob): Promise<Outcome<UploadedMedia>> {
  return request<UploadedMedia>('/api/messages/media', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  });
}
