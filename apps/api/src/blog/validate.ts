/**
 * 帖子 / 回复 / 分类的校验与归一化。
 *
 * 三条原则（与 `works/validate.ts` 同源）：
 *
 *   1. **不「尽力修正」，只报错或丢弃**。后台是给站长自己用的，输入错了直接说清楚比
 *      悄悄改掉更好——悄悄改会让人以为存进去的就是自己填的那个。
 *   2. **长度与数量都有上限**。`blog.json` 每次都整份读进内存再整份写出，一条 50MB 的
 *      正文会让整个列表接口卡住。
 *   3. **能力边界写在长度上**：标题 80、标签 5×16、正文 200KB、单帖 500 楼、总共 2000 帖。
 *      触到上限不是 bug，是「这个量级该换 SQLite」的信号，所以错误文案要说清。
 */

import type { PostStatus, VoteValue } from './types.js';
import { normalizeKey } from './types.js';

/** 带 HTTP 状态码与机器码的业务错误，路由层统一转成 `{ error, message }`。 */
export class BlogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BlogError';
  }
}

export const MAX_TITLE = 80;
export const MAX_MARKDOWN_BYTES = 200 * 1024;
export const MAX_TAGS = 5;
export const MAX_TAG = 16;
export const MAX_AUTHOR_NAME = 24;
export const MAX_REPLY_LENGTH = 2000;
export const MAX_REPLIES_PER_POST = 500;
export const MAX_POSTS = 2000;
export const MAX_CATEGORIES = 30;
export const MAX_CATEGORY_NAME = 20;
/** 一条回复里最多允许几个链接（再多基本就是引流的机器文）。 */
export const MAX_LINKS = 3;

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 30;
export const DEFAULT_REPLY_PAGE_SIZE = 20;
export const MAX_REPLY_PAGE_SIZE = 50;

/** slug：小写字母数字，单词之间一个连字符，不允许首尾连字符。 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * 封面地址：只认本站上传接口产出的命名。
 *
 * 与 `blog/media.ts` 的 `saveMedia()`（返回 `/api/blog/media/${file}`，文件名形如
 * `b-<sha1 前 16 位>.<ext>`）是同一份契约；那边改了路径前缀，这里必须同步。
 * 只放站内地址，外链一律拒——否则封面就成了一个可以往页面里塞任意图片的口子。
 */
const COVER_RE = /^\/api\/blog\/media\/b-[a-f0-9]{16}\.(?:png|jpg|webp|gif|avif)$/;

/**
 * 保留 slug：它们是路由里可能出现的静态段，或者一眼看上去像后台入口。
 *
 * 现在 `#blog/<param>` 只有「帖子详情」一种含义，所以冲突还不会真的发生；但这几个词
 * 一旦被占用，以后想加 `#blog/new` / `#blog/admin` 就得给老帖子改链接。挡在入口最便宜。
 */
const RESERVED_SLUGS = new Set([
  'new',
  'edit',
  'admin',
  'api',
  'posts',
  'post',
  'categories',
  'category',
  'tags',
  'captcha',
  'media',
  'rss',
  'feed',
]);

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 查询串里的值可能是数组（`?q=a&q=b`），只取第一个。 */
export function queryValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/* ---------------------------------------------------------------------------
   帖子
--------------------------------------------------------------------------- */

export interface PostFields {
  title: string;
  markdown: string;
  /** 空串 = 没有封面。 */
  coverImage: string;
  categoryId: string;
  tags: string[];
  locked: boolean;
  status: PostStatus;
  /** 空串 = 沿用当前作者署名（只在新建议题里用得到）。 */
  authorName: string;
}

function readTags(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new BlogError(400, 'validation_error', '标签必须是数组。');

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/^#/, '');
    if (!tag) continue;
    if (Array.from(tag).length > MAX_TAG) {
      throw new BlogError(400, 'validation_error', `单个标签最多 ${MAX_TAG} 个字。`);
    }
    const key = normalizeKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function readStatus(value: unknown, fallback: PostStatus): PostStatus {
  if (value === 'draft' || value === 'published') return value;
  if (value === undefined) return fallback;
  throw new BlogError(400, 'validation_error', 'status 只能是 draft 或 published。');
}

/**
 * 封面地址。
 *
 * 三态是刻意的：`undefined` 沿用旧值（后台「发布 / 下架」这类只传一个字段的按钮不能
 * 顺手把封面清掉），空串表示「删掉封面」，其余必须匹配本站上传结果。
 * **不要**写成 `asString(...) ?? base ?? ''`——那样空串与缺省会被合并，「清除封面」
 * 就没法表达了。
 */
function readCover(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new BlogError(400, 'validation_error', '封面地址必须是字符串。');
  }
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!COVER_RE.test(trimmed)) {
    throw new BlogError(
      400,
      'validation_error',
      '封面必须是本站上传接口返回的地址（/api/blog/media/…）。',
    );
  }
  return trimmed;
}

/**
 * 解析并归一化可写字段。
 *
 * `base` 为 `null` 按「新建」处理；给了旧记录按「局部更新」处理，缺字段沿用旧值——
 * 后台的「发布 / 下架」「关闭回复」这些只传一个字段的按钮因此能复用同一套校验。
 */
export function parsePostFields(body: unknown, base: PostFields | null): PostFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BlogError(400, 'validation_error', '请求体必须是一个对象。');
  }
  const input = body as Record<string, unknown>;

  const rawTitle = asString(input.title);
  const title = (rawTitle ?? base?.title ?? '').trim();
  if (!title) throw new BlogError(400, 'validation_error', '标题不能为空。');
  if (Array.from(title).length > MAX_TITLE) {
    throw new BlogError(400, 'validation_error', `标题最多 ${MAX_TITLE} 个字。`);
  }

  const rawMarkdown = input.markdown;
  if (rawMarkdown !== undefined && typeof rawMarkdown !== 'string') {
    throw new BlogError(400, 'validation_error', '正文必须是字符串。');
  }
  const markdown = (rawMarkdown as string | undefined) ?? base?.markdown ?? '';
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new BlogError(
      413,
      'validation_error',
      `正文太大了（上限 ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB）。长文建议拆成几篇。`,
    );
  }

  const categoryId = ((asString(input.categoryId) ?? base?.categoryId) ?? '').trim();
  if (!categoryId) {
    throw new BlogError(400, 'category_required', '先选一个分类：发帖时必须归类。');
  }

  const tags = readTags(input.tags, base?.tags ?? []);
  const coverImage = readCover(input.coverImage, base?.coverImage ?? '');
  const locked = typeof input.locked === 'boolean' ? input.locked : (base?.locked ?? false);
  const status = readStatus(input.status, base?.status ?? 'draft');

  const rawAuthor = asString(input.authorName);
  const authorName = (rawAuthor ?? base?.authorName ?? '').trim();
  if (Array.from(authorName).length > MAX_AUTHOR_NAME) {
    throw new BlogError(400, 'validation_error', `作者署名最多 ${MAX_AUTHOR_NAME} 个字。`);
  }

  return { title, markdown, coverImage, categoryId, tags, locked, status, authorName };
}

/**
 * 由标题生成 slug。
 *
 * 中文标题拉丁化不了（`normalize('NFKD')` 去不掉汉字），退化成一个 `post-<base36>`
 * 兜底——不好看，但至少能存；后台里可以手改，改完链接就固定了。
 */
export function slugifyPost(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (ascii.length >= 2 && !RESERVED_SLUGS.has(ascii)) return ascii;
  // 保留词（比如标题就叫「new」）也走兜底，别占掉以后要用的路由段。
  return `post-${Date.now().toString(36)}`;
}

/**
 * 解析最终 slug。规则与作品一致，理由也一样：
 *   · **作者手填**重复 → 409（自动加后缀会让人以为存的是自己填的那个，回头找不到链接）；
 *   · **由标题自动生成**重复 → 自动加 `-2`、`-3`（作者根本没关心过这个值）。
 */
export function resolvePostSlug(
  raw: unknown,
  title: string,
  current: string | null,
  taken: ReadonlySet<string>,
  ordered: (base: string) => string,
): string {
  if (raw === undefined) {
    return current ?? ordered(slugifyPost(title));
  }
  const text = asString(raw);
  if (text === null) throw new BlogError(400, 'validation_error', 'slug 必须是字符串。');
  const slug = text.trim().toLowerCase();
  if (!slug) return ordered(slugifyPost(title));
  if (!isSlug(slug)) {
    throw new BlogError(
      400,
      'validation_error',
      'slug 只能用小写字母、数字和连字符，且不能以连字符开头或结尾。',
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new BlogError(400, 'validation_error', `slug「${slug}」是保留字，换一个。`);
  }
  if (slug === current) return slug;
  if (taken.has(slug)) {
    throw new BlogError(409, 'slug_taken', `slug「${slug}」已经被别的帖子占用了。`);
  }
  return slug;
}

/* ---------------------------------------------------------------------------
   回复
--------------------------------------------------------------------------- */

export interface ReplyFields {
  body: string;
  replyToFloor: number | null;
}

/**
 * 回复正文：纯文本，只做三件事——统一换行、两端去空白、拒绝控制字符。
 *
 * **不做 Markdown**：回复是游客写的，纯文本 + `pre-wrap` 渲染既保住了换行，又让
 * 「渲染」这一步根本不存在，也就没有注入面。
 */
export function parseReplyFields(body: unknown): ReplyFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BlogError(400, 'validation_error', '请求体必须是一个对象。');
  }
  const input = body as Record<string, unknown>;

  const raw = asString(input.body);
  if (raw === null) throw new BlogError(400, 'validation_error', '回复内容必须是字符串。');

  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new BlogError(400, 'validation_error', '回复不能为空。');

  // 除换行与制表符外的控制字符一律拒绝（零宽字符也在里面）。
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029]/.test(text)) {
    throw new BlogError(400, 'validation_error', '回复里有不可见字符，去掉再试。');
  }

  const length = Array.from(text).length;
  if (length < 2) throw new BlogError(400, 'validation_error', '回复太短了，至少写两个字。');
  if (length > MAX_REPLY_LENGTH) {
    throw new BlogError(400, 'validation_error', `回复最多 ${MAX_REPLY_LENGTH} 个字。`);
  }

  const links = text.match(/https?:\/\//g);
  if (links && links.length > MAX_LINKS) {
    throw new BlogError(400, 'too_many_links', `一条回复里最多放 ${MAX_LINKS} 个链接。`);
  }

  const rawFloor = input.replyToFloor;
  let replyToFloor: number | null = null;
  if (rawFloor !== undefined && rawFloor !== null) {
    if (typeof rawFloor !== 'number' || !Number.isInteger(rawFloor) || rawFloor < 1) {
      throw new BlogError(400, 'validation_error', 'replyToFloor 必须是正整数楼层号。');
    }
    replyToFloor = rawFloor;
  }

  return { body: text, replyToFloor };
}

/* ---------------------------------------------------------------------------
   分类
--------------------------------------------------------------------------- */

export interface CategoryFields {
  name: string;
}

export function parseCategoryFields(body: unknown, base: CategoryFields | null): CategoryFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BlogError(400, 'validation_error', '请求体必须是一个对象。');
  }
  const input = body as Record<string, unknown>;
  const name = ((asString(input.name) ?? base?.name) ?? '').trim();
  if (!name) throw new BlogError(400, 'validation_error', '分类名不能为空。');
  if (Array.from(name).length > MAX_CATEGORY_NAME) {
    throw new BlogError(400, 'validation_error', `分类名最多 ${MAX_CATEGORY_NAME} 个字。`);
  }
  return { name };
}

/* ---------------------------------------------------------------------------
   查询参数
--------------------------------------------------------------------------- */

export type PostSort = 'new' | 'hot';

export interface PostQuery {
  q: string;
  /** 空串 = 全部。 */
  categoryId: string;
  /** 正规化后的标签键；空串 = 全部。 */
  tag: string;
  sort: PostSort;
  limit: number;
  cursor: string;
}

export function parsePostQuery(raw: Record<string, unknown>): PostQuery {
  const sort = queryValue(raw.sort) === 'hot' ? 'hot' : 'new';
  return {
    // 搜索词截断到 80：再长的词也没人真的会用到，但会让每次比较都变慢。
    q: Array.from(queryValue(raw.q)).slice(0, 80).join(''),
    categoryId: queryValue(raw.cat ?? raw.category),
    tag: normalizeKey(queryValue(raw.tag)),
    sort,
    limit: clampInt(queryValue(raw.limit), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    cursor: queryValue(raw.cursor),
  };
}

export function parseReplyQuery(raw: Record<string, unknown>): { limit: number; cursor: string } {
  return {
    limit: clampInt(queryValue(raw.limit), DEFAULT_REPLY_PAGE_SIZE, 1, MAX_REPLY_PAGE_SIZE),
    cursor: queryValue(raw.cursor),
  };
}

/* ---------------------------------------------------------------------------
   投票
--------------------------------------------------------------------------- */

export function parseVote(value: unknown): VoteValue {
  if (value === 1 || value === -1 || value === 0) return value;
  throw new BlogError(400, 'validation_error', 'value 只能是 1、-1 或 0。');
}
