/**
 * `/api/blog` 的窄客户端。
 *
 * 与 `works/api.ts` 同一套原则：**页面只认这里的类型**，`fetch` 的细节不外泄；函数
 * **永不抛异常**，调用方拿到的永远是一个可判定的结果。
 *
 * 两条与作品不同的地方：
 *
 *   1. **必须带 cookie**（`credentials: 'same-origin'`）。列表/详情里的 `myVote`、
 *      以及"我是登录用户还是游客"决定了回复表单长什么样。
 *   2. **失败要带回服务端的错误码**。发回复可能被限流（429）、被验证码拦（400）、
 *      被判重复（409），这些分支要给出不同的提示，光有"失败了"不够用。
 */

import type {
  CategoryView,
  Challenge,
  PostList,
  PostPage,
  PostSort,
  ReplyCreated,
  ReplyInput,
  ReplyPage,
  ReplyView,
  PostSummary,
  TagView,
  VoteResult,
  VoteValue,
} from './types';

/** 统一失败形状。`status === 0` 表示连不上后端；`message === ''` 表示被主动取消。 */
export interface BlogFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  retryAfterSeconds: number | null;
}

export type Outcome<T> = { ok: true; data: T } | BlogFailure;

export type PostResult =
  | { kind: 'ok'; page: PostPage }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

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

function networkFailure(): BlogFailure {
  return {
    ok: false,
    status: 0,
    error: 'network',
    message: '连不上后端服务，请确认 apps/api 已经启动。',
    retryAfterSeconds: null,
  };
}

/** 被调用方取消：文案留空，让页面「静默退出」而不是弹一句错误。 */
function abortedFailure(): BlogFailure {
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
      // 后台刚发完就该看到；而且列表/详情的 myVote 依赖会话，缓存会串味。
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
   形状检查
--------------------------------------------------------------------------- */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asVote(value: unknown): VoteValue {
  return value === 1 || value === -1 ? value : 0;
}

function readAuthor(raw: unknown): PostSummary['author'] {
  const value = (raw ?? {}) as Record<string, unknown>;
  const kind = value.kind === 'admin' || value.kind === 'user' ? value.kind : 'guest';
  return {
    kind,
    id: asString(value.id),
    nickname: asString(value.nickname, '游客'),
    avatarUrl: asString(value.avatarUrl),
    deleted: value.deleted === true,
    owner: value.owner === true,
  };
}

function readPost(raw: unknown): PostSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const slug = asString(value.slug);
  if (!slug) return null;
  const category = value.category as { id?: unknown; name?: unknown } | null | undefined;

  return {
    id: asString(value.id),
    slug,
    title: asString(value.title, '（无标题）'),
    excerpt: asString(value.excerpt),
    // 白名单里漏一个字段，服务端发了也白搭（会被静默丢掉）。
    coverImage: asString(value.coverImage),
    category:
      category && typeof category.name === 'string'
        ? { id: asString(category.id), name: category.name }
        : null,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    author: readAuthor(value.author),
    score: asNumber(value.score),
    up: asNumber(value.up),
    down: asNumber(value.down),
    replyCount: asNumber(value.replyCount),
    locked: value.locked === true,
    status: value.status === 'draft' ? 'draft' : 'published',
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : null,
    lastReplyAt: typeof value.lastReplyAt === 'string' ? value.lastReplyAt : null,
    myVote: asVote(value.myVote),
  };
}

function readReply(raw: unknown): ReplyView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    floor: asNumber(value.floor),
    author: readAuthor(value.author),
    body: asString(value.body),
    replyToFloor: typeof value.replyToFloor === 'number' ? value.replyToFloor : null,
    replyToName: asString(value.replyToName),
    score: asNumber(value.score),
    up: asNumber(value.up),
    down: asNumber(value.down),
    myVote: asVote(value.myVote),
    status: value.status === 'hidden' ? 'hidden' : 'visible',
    createdAt: asString(value.createdAt),
  };
}

function readReplies(raw: unknown): ReplyView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readReply).filter((item): item is ReplyView => item !== null);
}

/* ---------------------------------------------------------------------------
   公开接口
--------------------------------------------------------------------------- */

export interface PostQueryInput {
  q: string;
  categoryId: string;
  tag: string;
  sort: PostSort;
  cursor: string;
  limit: number;
}

export async function fetchPosts(
  input: PostQueryInput,
  signal?: AbortSignal,
): Promise<Outcome<PostList>> {
  const params = new URLSearchParams();
  if (input.q) params.set('q', input.q);
  if (input.categoryId) params.set('cat', input.categoryId);
  if (input.tag) params.set('tag', input.tag);
  if (input.sort !== 'new') params.set('sort', input.sort);
  if (input.cursor) params.set('cursor', input.cursor);
  params.set('limit', String(input.limit));

  const result = await request<{ posts?: unknown; nextCursor?: unknown; total?: unknown }>(
    `/api/blog/posts?${params.toString()}`,
    {},
    signal,
  );
  if (!result.ok) return result;

  const posts = Array.isArray(result.data?.posts)
    ? result.data.posts.map(readPost).filter((item): item is PostSummary => item !== null)
    : [];
  return {
    ok: true,
    data: {
      posts,
      nextCursor: typeof result.data?.nextCursor === 'string' ? result.data.nextCursor : null,
      total: asNumber(result.data?.total, posts.length),
    },
  };
}

export async function fetchPost(slug: string, signal?: AbortSignal): Promise<PostResult> {
  const result = await request<{ post?: unknown; replies?: unknown; replyCursor?: unknown }>(
    `/api/blog/posts/${encodeURIComponent(slug)}`,
    {},
    signal,
  );
  if (!result.ok) {
    if (result.status === 404) return { kind: 'missing' };
    return { kind: 'error', message: result.message };
  }

  const rawPost = result.data?.post as Record<string, unknown> | undefined;
  const post = readPost(rawPost);
  if (!post) return { kind: 'missing' };

  const page: PostPage = {
    post: { ...post, markdown: asString(rawPost?.markdown) },
    replies: readReplies(result.data?.replies),
    replyCursor: typeof result.data?.replyCursor === 'string' ? result.data.replyCursor : null,
  };
  return { kind: 'ok', page };
}

export async function fetchReplies(
  slug: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<Outcome<ReplyPage>> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const result = await request<{ replies?: unknown; nextCursor?: unknown }>(
    `/api/blog/posts/${encodeURIComponent(slug)}/replies?${params.toString()}`,
    {},
    signal,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      replies: readReplies(result.data?.replies),
      nextCursor: typeof result.data?.nextCursor === 'string' ? result.data.nextCursor : null,
    },
  };
}

export async function fetchCategories(
  signal?: AbortSignal,
): Promise<Outcome<CategoryView[]>> {
  const result = await request<{ categories?: unknown }>('/api/blog/categories', {}, signal);
  if (!result.ok) return result;
  const list = Array.isArray(result.data?.categories) ? result.data.categories : [];
  return {
    ok: true,
    data: list
      .map((raw) => {
        const value = (raw ?? {}) as Record<string, unknown>;
        const id = asString(value.id);
        if (!id) return null;
        return {
          id,
          name: asString(value.name, '未分类'),
          key: asString(value.key),
          order: asNumber(value.order),
          count: asNumber(value.count),
        } satisfies CategoryView;
      })
      .filter((item): item is CategoryView => item !== null),
  };
}

export async function fetchTags(limit = 12, signal?: AbortSignal): Promise<Outcome<TagView[]>> {
  const result = await request<{ tags?: unknown }>(`/api/blog/tags?limit=${limit}`, {}, signal);
  if (!result.ok) return result;
  const list = Array.isArray(result.data?.tags) ? result.data.tags : [];
  return {
    ok: true,
    data: list
      .map((raw) => {
        const value = (raw ?? {}) as Record<string, unknown>;
        const key = asString(value.key);
        if (!key) return null;
        return { key, label: asString(value.label, key), count: asNumber(value.count) } satisfies TagView;
      })
      .filter((item): item is TagView => item !== null),
  };
}

export async function fetchCaptcha(signal?: AbortSignal): Promise<Outcome<Challenge>> {
  const result = await request<Record<string, unknown>>('/api/blog/captcha', {}, signal);
  if (!result.ok) return result;

  const value = result.data ?? {};
  const challenge = asString(value.challenge);
  const salt = asString(value.salt);
  const signature = asString(value.signature);
  const maxnumber = asNumber(value.maxnumber, 0);

  if (!challenge || !salt || !signature || maxnumber <= 0) {
    return {
      ok: false,
      status: 0,
      error: 'captcha_missing',
      message: '验证题没取到，稍后重试。',
      retryAfterSeconds: null,
    };
  }

  return {
    ok: true,
    data: {
      algorithm: 'SHA-256',
      challenge,
      salt,
      signature,
      maxnumber,
      expiresAt: asString(value.expiresAt),
      minElapsedMs: asNumber(value.minElapsedMs, 600),
    },
  };
}

export async function postReply(
  slug: string,
  input: ReplyInput,
  signal?: AbortSignal,
): Promise<Outcome<ReplyCreated>> {
  const body: Record<string, unknown> = {
    body: input.body,
    // 蜜罐字段：正常用户永远看不到也填不到，只有照着 DOM 填表单的脚本会踩中。
    website: input.honeypot,
  };
  if (input.replyToFloor !== null) body.replyToFloor = input.replyToFloor;
  if (input.captcha) body.captcha = input.captcha;

  const result = await request<{ reply?: unknown; replyCount?: unknown }>(
    `/api/blog/posts/${encodeURIComponent(slug)}/replies`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!result.ok) return result;

  const reply = readReply(result.data?.reply);
  if (!reply) {
    return {
      ok: false,
      status: 0,
      error: 'bad_payload',
      message: '回复发出去了，但返回的数据看不懂。刷新一下就能看到。',
      retryAfterSeconds: null,
    };
  }
  return { ok: true, data: { reply, replyCount: asNumber(result.data?.replyCount) } };
}

function readVoteResult(raw: unknown): VoteResult {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    score: asNumber(value.score),
    up: asNumber(value.up),
    down: asNumber(value.down),
    myVote: asVote(value.myVote),
  };
}

export async function votePost(
  slug: string,
  value: VoteValue,
  signal?: AbortSignal,
): Promise<Outcome<VoteResult>> {
  const result = await request<Record<string, unknown>>(
    `/api/blog/posts/${encodeURIComponent(slug)}/vote`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    signal,
  );
  if (!result.ok) return result;
  return { ok: true, data: readVoteResult(result.data) };
}

export async function voteReply(
  id: string,
  value: VoteValue,
  signal?: AbortSignal,
): Promise<Outcome<VoteResult>> {
  const result = await request<Record<string, unknown>>(
    `/api/blog/replies/${encodeURIComponent(id)}/vote`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    signal,
  );
  if (!result.ok) return result;
  return { ok: true, data: readVoteResult(result.data) };
}

/** 帖子详情地址。集中在这里，免得各处各写一遍模板字符串写歪。 */
export function postHref(slug: string): string {
  return `#blog/${encodeURIComponent(slug)}`;
}
