/**
 * 博客的持久化层。
 *
 * **为什么所有东西塞进一个 `blog.json`**：楼层号分配、投票的读改写、以及「删分类前
 * 检查有没有帖子引用」这三件事都要原子。拆成 posts / replies / categories 三个文件
 * 就得跨三条串行队列做补偿，中间任何一个窗口失败都会留下一份对不上的数据。一份文件
 * 一条队列，这些问题全部消失，代价是每次写入都重写全部正文——所以有明确的数据量上限
 * （见 `validate.ts`）。**超过「2000 帖 / 单帖 500 楼」这个量级，应该换 SQLite，而不是
 * 继续在这里加缓存。**
 *
 * 四条实现纪律：
 *
 *   1. **派生值不落盘**。`score` / `replyCount` 这些由 `types.ts` 的纯函数现算，绝不
 *      和内容分两处写——它们不可能漂移，列表与详情也不可能算出两个不同的数。
 *   2. **判断必须发生在 `mutate()` 回调内**。楼层号、slug 唯一性、分类引用、投票
 *      upsert 全靠这条串行链互斥；放在回调外面「先读再写」两个并发请求就会撞车。
 *   3. **回复没有硬删除**。这里只导出 `setReplyStatus`，不导出任何删回复的函数——
 *      楼层号一旦断档，所有 `#n` 引用就集体错位且无法修复。
 *   4. **原子写由 `createJsonStore` 负责**（临时文件 → fsync → rename + `.bak`）。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../data/json-store.js';
import {
  BlogError,
  MAX_CATEGORIES,
  MAX_POSTS,
  MAX_REPLIES_PER_POST,
  parseCategoryFields,
  parsePostFields,
  parseReplyQuery,
  resolvePostSlug,
} from './validate.js';
import type { PostFields, PostQuery } from './validate.js';
import {
  myVoteOf,
  normalizeKey,
  pickDetail,
  pickReply,
  pickSummary,
  replyCountOf,
  scoreOf,
  tally,
  type AuthorSnapshot,
  type BlogState,
  type CategoryRecord,
  type CategoryView,
  type LiveAuthors,
  type PostDetail,
  type PostRecord,
  type PostStatus,
  type PostSummary,
  type ReplyRecord,
  type ReplyStatus,
  type ReplyView,
  type TagView,
  type VoteValue,
} from './types.js';

/** 源码在 `src/blog/store.ts`、编译在 `dist/blog/store.js`，两者都往上两跳。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');

/** 数据文件（`.bak` 由 `createJsonStore` 自动维护）。 */
export const blogFile = path.join(DATA_DIR, 'blog.json');

/** 首次启动时预置的分类。发帖必须选一个分类，空表会让后台一步都走不动。 */
const DEFAULT_CATEGORY_NAMES = ['随笔', '技术', '生活'];

const stamp = (): string => new Date().toISOString();

/* ---------------------------------------------------------------------------
   store 实例
--------------------------------------------------------------------------- */

function createEmpty(): BlogState {
  const now = stamp();
  return {
    version: 1,
    updatedAt: now,
    posts: [],
    categories: DEFAULT_CATEGORY_NAMES.map((name, index) => ({
      id: randomUUID(),
      name,
      key: normalizeKey(name),
      order: index,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function parseState(raw: unknown): BlogState {
  if (typeof raw !== 'object' || raw === null) {
    throw new BlogError(500, 'blog_store_error', 'blog.json 的结构不对：顶层不是对象。');
  }
  const state = raw as BlogState;
  if (!Array.isArray(state.posts) || !Array.isArray(state.categories)) {
    throw new BlogError(500, 'blog_store_error', 'blog.json 的结构不对：缺少 posts 或 categories。');
  }
  // 逐条检查最小结构：与其带着一条残缺记录跑出各种 undefined，不如当场说清楚。
  for (const post of state.posts) {
    if (
      !post ||
      typeof post.id !== 'string' ||
      typeof post.slug !== 'string' ||
      !Array.isArray(post.replies)
    ) {
      throw new BlogError(
        500,
        'blog_store_error',
        'blog.json 里有结构不对的帖子（缺少 id / slug / replies），请先修好（同目录有 .bak）。',
      );
    }
  }
  return state;
}

const store = createJsonStore<BlogState>({
  dir: DATA_DIR,
  filePath: blogFile,
  createEmpty,
  parse: parseState,
  fail: (message) => new BlogError(500, 'blog_store_error', message),
});

/* ---------------------------------------------------------------------------
   游标
--------------------------------------------------------------------------- */

type SortKeyTuple = [number, string, string];

interface CursorPayload {
  s: 'new' | 'hot';
  v: SortKeyTuple;
}

/** 热度 = 净票数 × 2 + 可见回复数。乘 2 是让一票的价值明显高于一条回复。 */
function hotValue(post: PostRecord): number {
  return scoreOf(post.votes) * 2 + replyCountOf(post);
}

function sortKeyOf(post: PostRecord, sort: 'new' | 'hot'): SortKeyTuple {
  const time = post.publishedAt ?? post.createdAt;
  return sort === 'hot' ? [hotValue(post), time, post.id] : [0, time, post.id];
}

/** 大的在前（分数降序）→ 新的在前（时间降序）→ id 降序（保证排序确定）。 */
function compareKeys(a: SortKeyTuple, b: SortKeyTuple): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1;
  if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
  return 0;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, sort: 'new' | 'hot'): CursorPayload {
  const bad = (): never => {
    throw new BlogError(400, 'bad_cursor', '分页游标无效，刷新一下列表就好。');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  const payload = parsed as CursorPayload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload.s !== 'new' && payload.s !== 'hot') ||
    !Array.isArray(payload.v) ||
    payload.v.length !== 3 ||
    typeof payload.v[0] !== 'number' ||
    typeof payload.v[1] !== 'string' ||
    typeof payload.v[2] !== 'string'
  ) {
    return bad();
  }
  // 换了排序方式还用旧游标：位置语义完全不同，直接让前端从头拉。
  if (payload.s !== sort) return bad();
  return payload;
}

function encodeFloorCursor(floor: number): string {
  return Buffer.from(JSON.stringify({ f: floor }), 'utf8').toString('base64url');
}

function decodeFloorCursor(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BlogError(400, 'bad_cursor', '分页游标无效，刷新一下就好。');
  }
  const floor = (parsed as { f?: unknown }).f;
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0) {
    throw new BlogError(400, 'bad_cursor', '分页游标无效，刷新一下就好。');
  }
  return floor;
}

/* ---------------------------------------------------------------------------
   内部工具
--------------------------------------------------------------------------- */

function categoryMap(state: BlogState): Map<string, CategoryRecord> {
  return new Map(state.categories.map((category) => [category.id, category]));
}

function matchesQuery(post: PostRecord, needle: string): boolean {
  if (!needle) return true;
  if (post.titleKey.includes(needle)) return true;
  if (post.tagKeys.some((tag) => tag.includes(needle))) return true;
  // 正文每次现场小写比较：存一份搜索键等于把正文体积翻倍，而这个站点的帖子量
  // 远没到需要倒排索引的程度。真要快了再说，接口形状不用变。
  return post.markdown.toLowerCase().includes(needle);
}

function replyPage(
  post: PostRecord,
  limit: number,
  cursor: string,
  viewerId: string | null,
  live: LiveAuthors,
  keepHiddenBody: boolean,
): { replies: ReplyView[]; nextCursor: string | null } {
  const after = cursor ? decodeFloorCursor(cursor) : 0;
  const rest = post.replies.filter((reply) => reply.floor > after);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    replies: page.map((reply) => pickReply(reply, live, viewerId, keepHiddenBody)),
    nextCursor: last && rest.length > page.length ? encodeFloorCursor(last.floor) : null,
  };
}

function requirePublished(state: BlogState, slug: string): PostRecord {
  const post = state.posts.find((item) => item.slug === slug && item.status === 'published');
  if (!post) throw new BlogError(404, 'not_found', '没有这篇帖子，可能已经被删掉了。');
  return post;
}

function applyVote<T extends { votes: Record<string, 1 | -1> }>(
  target: T,
  userId: string,
  value: VoteValue,
): { score: number; up: number; down: number; myVote: VoteValue } {
  if (value === 0) delete target.votes[userId];
  else target.votes[userId] = value;
  const { up, down } = tally(target.votes);
  return { score: up - down, up, down, myVote: myVoteOf(target.votes, userId) };
}

/* ---------------------------------------------------------------------------
   公开读
--------------------------------------------------------------------------- */

export interface PostListResult {
  posts: PostSummary[];
  nextCursor: string | null;
  total: number;
}

export function listPosts(
  query: PostQuery,
  viewerId: string | null,
  live: LiveAuthors,
): Promise<PostListResult> {
  return store.read().then((state) => {
    const cats = categoryMap(state);
    const needle = query.q ? normalizeKey(query.q) : '';

    const filtered = state.posts.filter(
      (post) =>
        post.status === 'published' &&
        (!query.categoryId || post.categoryId === query.categoryId) &&
        (!query.tag || post.tagKeys.includes(query.tag)) &&
        matchesQuery(post, needle),
    );

    const sorted = [...filtered].sort((a, b) =>
      compareKeys(sortKeyOf(a, query.sort), sortKeyOf(b, query.sort)),
    );

    let start = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, query.sort);
      const found = sorted.findIndex((post) => compareKeys(sortKeyOf(post, query.sort), cursor.v) > 0);
      start = found < 0 ? sorted.length : found;
    }

    const page = sorted.slice(start, start + query.limit);
    const last = page[page.length - 1];
    const hasMore = start + page.length < sorted.length;

    return {
      posts: page.map((post) => pickSummary(post, cats.get(post.categoryId), live, viewerId)),
      nextCursor: last && hasMore ? encodeCursor({ s: query.sort, v: sortKeyOf(last, query.sort) }) : null,
      total: filtered.length,
    };
  });
}

export interface PostPage {
  post: PostDetail;
  replies: ReplyView[];
  replyCursor: string | null;
}

/** 详情 + 第一页回复。`draft` 对公开站点来说等于不存在（别让链接能猜到草稿）。 */
export function findPostPage(
  slug: string,
  viewerId: string | null,
  live: LiveAuthors,
  replyLimit: number,
): Promise<PostPage | null> {
  return store.read().then((state) => {
    const post = state.posts.find((item) => item.slug === slug && item.status === 'published');
    if (!post) return null;
    const cats = categoryMap(state);
    const page = replyPage(post, replyLimit, '', viewerId, live, false);
    return {
      post: pickDetail(post, cats.get(post.categoryId), live, viewerId),
      replies: page.replies,
      replyCursor: page.nextCursor,
    };
  });
}

export function listReplies(
  slug: string,
  raw: Record<string, unknown>,
  viewerId: string | null,
  live: LiveAuthors,
): Promise<{ replies: ReplyView[]; nextCursor: string | null }> {
  const { limit, cursor } = parseReplyQuery(raw);
  return store.read().then((state) => replyPage(requirePublished(state, slug), limit, cursor, viewerId, live, false));
}

export function listCategories(includeDrafts = false): Promise<CategoryView[]> {
  return store.read().then((state) => {
    const counts = new Map<string, number>();
    for (const post of state.posts) {
      if (!includeDrafts && post.status !== 'published') continue;
      counts.set(post.categoryId, (counts.get(post.categoryId) ?? 0) + 1);
    }
    return [...state.categories]
      .sort((a, b) => a.order - b.order)
      .map((category) => ({
        id: category.id,
        name: category.name,
        key: category.key,
        order: category.order,
        count: counts.get(category.id) ?? 0,
      }));
  });
}

export function listTags(limit = 40): Promise<TagView[]> {
  return store.read().then((state) => {
    const tallyTags = new Map<string, { label: string; count: number }>();
    for (const post of state.posts) {
      if (post.status !== 'published') continue;
      post.tags.forEach((label, index) => {
        const key = post.tagKeys[index] ?? normalizeKey(label);
        if (!key) return;
        const found = tallyTags.get(key);
        if (found) found.count += 1;
        else tallyTags.set(key, { label, count: 1 });
      });
    }
    return [...tallyTags.entries()]
      .map(([key, value]) => ({ key, label: value.label, count: value.count }))
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : 1))
      .slice(0, limit);
  });
}

/* ---------------------------------------------------------------------------
   公开写：回复与投票
--------------------------------------------------------------------------- */

export interface NewReplyInput {
  body: string;
  replyToFloor: number | null;
  author: AuthorSnapshot;
  ipHash: string;
}

export function addReply(
  slug: string,
  input: NewReplyInput,
): Promise<{ reply: ReplyRecord; replyCount: number }> {
  return store.mutate((state) => {
    const post = requirePublished(state, slug);
    if (post.locked) throw new BlogError(403, 'post_locked', '这篇帖子的回复已经关闭了。');

    if (post.replies.length >= MAX_REPLIES_PER_POST) {
      throw new BlogError(
        409,
        'reply_limit',
        `这篇帖子的楼层已经满了（上限 ${MAX_REPLIES_PER_POST} 楼）。`,
      );
    }

    let replyToName = '';
    if (input.replyToFloor !== null) {
      const target = post.replies.find(
        (reply) => reply.floor === input.replyToFloor && reply.status === 'visible',
      );
      if (!target) throw new BlogError(400, 'validation_error', '要引用的楼层不存在，刷新一下再试。');
      // 只从服务端的楼层快照取名，**忽略**客户端传来的任何昵称。
      replyToName = target.author.nickname;
    }

    const now = stamp();
    const record: ReplyRecord = {
      id: randomUUID(),
      // 楼层号在互斥区内分配：放在回调外面「先读长度再写」，两个并发回复会撞号。
      floor: post.replies.length + 1,
      author: input.author,
      body: input.body,
      replyToFloor: input.replyToFloor,
      replyToName,
      status: 'visible',
      votes: {},
      ipHash: input.ipHash,
      createdAt: now,
      deletedAt: null,
    };

    post.replies.push(record);
    state.updatedAt = now;
    return { reply: record, replyCount: replyCountOf(post) };
  });
}

export interface VoteResult {
  score: number;
  up: number;
  down: number;
  myVote: VoteValue;
}

export function setPostVote(slug: string, userId: string, value: VoteValue): Promise<VoteResult> {
  return store.mutate((state) => {
    const post = requirePublished(state, slug);
    const result = applyVote(post, userId, value);
    state.updatedAt = stamp();
    return result;
  });
}

export function setReplyVote(replyId: string, userId: string, value: VoteValue): Promise<VoteResult> {
  return store.mutate((state) => {
    for (const post of state.posts) {
      const reply = post.replies.find((item) => item.id === replyId);
      if (!reply) continue;
      if (reply.status !== 'visible') {
        throw new BlogError(404, 'not_found', '这条回复已经不存在了。');
      }
      const result = applyVote(reply, userId, value);
      state.updatedAt = stamp();
      return result;
    }
    throw new BlogError(404, 'not_found', '没有这条回复。');
  });
}

/* ---------------------------------------------------------------------------
   管理端
--------------------------------------------------------------------------- */

export interface AdminPostFilter {
  q: string;
  /** 空串 = 全部状态。 */
  status: PostStatus | '';
  categoryId: string;
}

export function listAdminPosts(filter: AdminPostFilter, live: LiveAuthors): Promise<PostSummary[]> {
  return store.read().then((state) => {
    const cats = categoryMap(state);
    const needle = filter.q ? normalizeKey(filter.q) : '';
    return state.posts
      .filter((post) => !filter.status || post.status === filter.status)
      .filter((post) => !filter.categoryId || post.categoryId === filter.categoryId)
      .filter((post) => matchesQuery(post, needle))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((post) => pickSummary(post, cats.get(post.categoryId), live, null));
  });
}

export function findPostById(id: string): Promise<PostRecord | null> {
  return store.read().then((state) => state.posts.find((post) => post.id === id) ?? null);
}

function orderedSlugFactory(taken: ReadonlySet<string>): (base: string) => string {
  return (base: string): string => {
    if (!taken.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const next = `${base}-${index}`;
      if (!taken.has(next)) return next;
    }
    return `${base}-${Date.now().toString(36)}`;
  };
}

export function createPost(body: unknown, author: AuthorSnapshot): Promise<PostRecord> {
  // 纯校验放在队列外面：慢活不该占着串行链（与「scrypt 必须在 mutate 之前算完」同理）。
  const fields = parsePostFields(body, null);
  const rawSlug = (body as Record<string, unknown>).slug;

  return store.mutate((state) => {
    if (state.posts.length >= MAX_POSTS) {
      throw new BlogError(409, 'post_limit', `帖子总数到上限了（${MAX_POSTS} 篇）。`);
    }
    if (!state.categories.some((category) => category.id === fields.categoryId)) {
      throw new BlogError(400, 'category_required', '选中的分类不存在，刷新后重新选一个。');
    }

    const taken = new Set(state.posts.map((post) => post.slug));
    const slug = resolvePostSlug(rawSlug, fields.title, null, taken, orderedSlugFactory(taken));

    const now = stamp();
    const record: PostRecord = {
      id: randomUUID(),
      slug,
      title: fields.title,
      titleKey: normalizeKey(fields.title),
      markdown: fields.markdown,
      coverImage: fields.coverImage,
      categoryId: fields.categoryId,
      tags: [...fields.tags],
      tagKeys: fields.tags.map(normalizeKey),
      author: { ...author, nickname: fields.authorName || author.nickname },
      status: fields.status,
      locked: fields.locked,
      votes: {},
      replies: [],
      createdAt: now,
      updatedAt: now,
      publishedAt: fields.status === 'published' ? now : null,
    };

    state.posts.push(record);
    state.updatedAt = now;
    return record;
  });
}

export function updatePost(id: string, body: unknown): Promise<PostRecord> {
  return store.mutate((state) => {
    const index = state.posts.findIndex((post) => post.id === id);
    const current = state.posts[index];
    if (!current) throw new BlogError(404, 'not_found', '没有这篇帖子，可能已经被删掉了。');

    const base: PostFields = {
      title: current.title,
      markdown: current.markdown,
      // 老记录没有这个键：`?? ''` 既是类型兜底，也顺手把旧数据归一。
      coverImage: current.coverImage ?? '',
      categoryId: current.categoryId,
      tags: current.tags,
      locked: current.locked,
      status: current.status,
      authorName: current.author.nickname,
    };
    const fields = parsePostFields(body, base);

    if (!state.categories.some((category) => category.id === fields.categoryId)) {
      throw new BlogError(400, 'category_required', '选中的分类不存在，刷新后重新选一个。');
    }

    const taken = new Set(state.posts.filter((post) => post.id !== id).map((post) => post.slug));
    const slug = resolvePostSlug(
      (body as Record<string, unknown>).slug,
      fields.title,
      current.slug,
      taken,
      orderedSlugFactory(taken),
    );

    const now = stamp();
    const next: PostRecord = {
      ...current,
      title: fields.title,
      titleKey: normalizeKey(fields.title),
      markdown: fields.markdown,
      coverImage: fields.coverImage,
      categoryId: fields.categoryId,
      tags: [...fields.tags],
      tagKeys: fields.tags.map(normalizeKey),
      author: { ...current.author, nickname: fields.authorName || current.author.nickname },
      status: fields.status,
      locked: fields.locked,
      slug,
      updatedAt: now,
      // 首次发布才写发布时间；下架不清空、重发也不覆盖。
      publishedAt: current.publishedAt ?? (fields.status === 'published' ? now : null),
    };

    state.posts[index] = next;
    state.updatedAt = now;
    return next;
  });
}

export function setPostStatus(id: string, status: PostStatus): Promise<PostRecord> {
  return updatePost(id, { status });
}

export function removePost(id: string): Promise<{ removedReplies: number }> {
  return store.mutate((state) => {
    const index = state.posts.findIndex((post) => post.id === id);
    const target = state.posts[index];
    if (!target) throw new BlogError(404, 'not_found', '没有这篇帖子，可能已经被删掉了。');
    state.posts.splice(index, 1);
    state.updatedAt = stamp();
    return { removedReplies: target.replies.length };
  });
}

export function listAdminReplies(
  postId: string,
  raw: Record<string, unknown>,
  live: LiveAuthors,
): Promise<{ replies: ReplyView[]; nextCursor: string | null }> {
  const { limit, cursor } = parseReplyQuery(raw);
  return store.read().then((state) => {
    const post = state.posts.find((item) => item.id === postId);
    if (!post) throw new BlogError(404, 'not_found', '没有这篇帖子。');
    // 后台要看得到被隐藏的正文，否则「复核」无从下手。
    return replyPage(post, limit, cursor, null, live, true);
  });
}

export function setReplyStatus(replyId: string, status: ReplyStatus): Promise<ReplyRecord> {
  return store.mutate((state) => {
    for (const post of state.posts) {
      const reply = post.replies.find((item) => item.id === replyId);
      if (!reply) continue;
      reply.status = status;
      reply.deletedAt = status === 'hidden' ? stamp() : null;
      state.updatedAt = stamp();
      return reply;
    }
    throw new BlogError(404, 'not_found', '没有这条回复。');
  });
}

/* ---------------------------------------------------------------------------
   分类
--------------------------------------------------------------------------- */

export function createCategory(body: unknown): Promise<CategoryRecord> {
  const fields = parseCategoryFields(body, null);
  const key = normalizeKey(fields.name);
  if (!key) throw new BlogError(400, 'validation_error', '分类名不能只有空格。');

  return store.mutate((state) => {
    if (state.categories.length >= MAX_CATEGORIES) {
      throw new BlogError(409, 'category_limit', `分类最多 ${MAX_CATEGORIES} 个。`);
    }
    if (state.categories.some((category) => category.key === key)) {
      throw new BlogError(409, 'category_taken', `已经有叫「${fields.name}」的分类了。`);
    }
    const now = stamp();
    const record: CategoryRecord = {
      id: randomUUID(),
      name: fields.name,
      key,
      order: state.categories.reduce((max, category) => Math.max(max, category.order), -1) + 1,
      createdAt: now,
      updatedAt: now,
    };
    state.categories.push(record);
    state.updatedAt = now;
    return record;
  });
}

export function updateCategory(id: string, body: unknown): Promise<CategoryRecord> {
  return store.read().then((state) => {
    const current = state.categories.find((category) => category.id === id);
    if (!current) throw new BlogError(404, 'not_found', '没有这个分类。');
    return parseCategoryFields(body, { name: current.name });
  }).then((fields) =>
    store.mutate((state) => {
      const index = state.categories.findIndex((category) => category.id === id);
      const current = state.categories[index];
      if (!current) throw new BlogError(404, 'not_found', '没有这个分类。');
      const key = normalizeKey(fields.name);
      if (!key) throw new BlogError(400, 'validation_error', '分类名不能只有空格。');
      if (state.categories.some((category) => category.id !== id && category.key === key)) {
        throw new BlogError(409, 'category_taken', `已经有叫「${fields.name}」的分类了。`);
      }
      const now = stamp();
      // 改名只动分类自己：帖子存的是 categoryId，这正是用 id 而不是名称的原因。
      const next: CategoryRecord = { ...current, name: fields.name, key, updatedAt: now };
      state.categories[index] = next;
      state.updatedAt = now;
      return next;
    }),
  );
}

export function removeCategory(id: string): Promise<{ ok: true }> {
  return store.mutate((state) => {
    const target = state.categories.find((category) => category.id === id);
    if (!target) throw new BlogError(404, 'not_found', '没有这个分类。');
    if (state.categories.length <= 1) {
      throw new BlogError(409, 'last_category', '至少要留一个分类：发帖时必须归类。');
    }
    // 引用检查必须在互斥区内：否则刚检查完，就有人发了一篇引用它的帖子。
    const used = state.posts.filter((post) => post.categoryId === id).length;
    if (used > 0) {
      throw new BlogError(
        409,
        'category_in_use',
        `这个分类下还有 ${used} 篇帖子，先把它们改到别的分类再删。`,
      );
    }
    state.categories = state.categories.filter((category) => category.id !== id);
    state.updatedAt = stamp();
    return { ok: true as const };
  });
}

/** 按给定的 id 顺序重排。必须是全量置换，漏一条会让那条的 order 落在旧值上。 */
export function reorderCategories(ids: readonly string[]): Promise<CategoryRecord[]> {
  return store.mutate((state) => {
    const currentIds = state.categories.map((category) => category.id);
    if (ids.length !== currentIds.length) {
      throw new BlogError(409, 'category_mismatch', '排序列表和现有分类数量不一致，请刷新后重试。');
    }
    const wanted = new Set(ids);
    if (wanted.size !== ids.length || !currentIds.every((id) => wanted.has(id))) {
      throw new BlogError(409, 'category_mismatch', '排序列表和现有分类对不上（有重复或缺失），请刷新。');
    }
    const position = new Map(ids.map((id, index) => [id, index]));
    const now = stamp();
    state.categories = state.categories.map((category) => {
      const order = position.get(category.id);
      if (order === undefined || order === category.order) return category;
      return { ...category, order, updatedAt: now };
    });
    state.updatedAt = now;
    return [...state.categories].sort((a, b) => a.order - b.order);
  });
}
