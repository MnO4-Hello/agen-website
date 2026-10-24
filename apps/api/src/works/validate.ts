/**
 * 作品字段的校验与归一化。
 *
 * 三条原则：
 *
 *   1. **不「尽力修正」，只报错或丢弃**。管理后台是给作者自己用的，输入错了直接说清楚
 *      比悄悄改掉更好——悄悄改会让人以为存进去的就是自己填的那个。
 *   2. **长度与数量都有上限**。这些上限不是洁癖：`works.json` 是整份读进内存的，
 *      一条 50MB 的 HTML 会让整个列表接口变慢。
 *   3. **两种模式互斥**。模板模式只存 `readme`，开发者模式只存 `html`。保存时按模式
 *      把另一侧清空——否则切换模式后会有一份看不见的旧内容躺在文件里。
 */

import type { WorkFields, WorkMode } from './types.js';

/** 带 HTTP 状态码的业务错误，路由层统一转成 JSON。 */
export class WorkError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkError';
  }
}

const MAX_TITLE = 80;
const MAX_SUMMARY = 200;
const MAX_TAGS = 8;
const MAX_TAG = 24;
const MAX_YEAR = 16;
const MAX_CATEGORY = 24;
const MAX_GALLERY = 12;
const MAX_README_BYTES = 200 * 1024;
const MAX_HTML_BYTES = 512 * 1024;

/** slug：小写字母数字，单词之间一个连字符，不允许首尾连字符。 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** 媒体地址：只认服务端生成的命名（见 `store.saveMedia`）。 */
const MEDIA_RE = /^\/api\/works\/media\/w-[a-f0-9]{16}\.(?:png|jpg|webp|gif|avif)$/;

/**
 * `2026` / `2026-10` / `2024 - 2026` / `2024—present`。
 *
 * 放宽到「数字开头、总长 ≤16」就够了：作者想写「2024 秋」也该能存。
 */
const YEAR_RE = /^\d{4}(?:\s*[-–—~]\s*(?:\d{4}|\d{2}|present|now|至今))?$/i;

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readMode(value: unknown, fallback: WorkMode): WorkMode {
  if (value === 'template' || value === 'developer') return value;
  if (value === undefined) return fallback;
  throw new WorkError(400, 'mode 只能是 template 或 developer。');
}

function readText(value: unknown, fallback: string, max: number, label: string): string {
  if (value === undefined) return fallback;
  const text = asString(value);
  if (text === null) throw new WorkError(400, `${label}必须是字符串。`);
  const trimmed = label === '标题' ? text.trim() : text.trimEnd();
  if (trimmed.length > max) throw new WorkError(400, `${label}最多 ${max} 个字符。`);
  return trimmed;
}

function readUrl(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  const text = asString(value);
  if (text === null) throw new WorkError(400, `${label}必须是字符串。`);
  const trimmed = text.trim();
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WorkError(400, `${label}不是一个合法地址。`);
  }
  // 只放行 http(s)：`javascript:` 之类的地址会被直接渲染成可点的链接。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WorkError(400, `${label}只能填 http 或 https 地址。`);
  }
  return url.href;
}

function readTags(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new WorkError(400, '标签必须是数组。');
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function readMedia(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  const text = asString(value);
  if (text === null) throw new WorkError(400, `${label}必须是字符串。`);
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!MEDIA_RE.test(trimmed)) {
    throw new WorkError(400, `${label}必须是本站上传接口返回的地址（/api/works/media/…）。`);
  }
  return trimmed;
}

function readGallery(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new WorkError(400, '图集必须是数组。');
  const shots: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!MEDIA_RE.test(trimmed)) {
      throw new WorkError(400, '图集里只能放本站上传接口返回的地址。');
    }
    shots.push(trimmed);
    if (shots.length >= MAX_GALLERY) break;
  }
  return shots;
}

function readLongText(value: unknown, fallback: string, maxBytes: number, label: string): string {
  if (value === undefined) return fallback;
  const text = asString(value);
  if (text === null) throw new WorkError(400, `${label}必须是字符串。`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new WorkError(413, `${label}太大了（上限 ${Math.round(maxBytes / 1024)} KB）。`);
  }
  return text;
}

/**
 * 解析并归一化可写字段。
 *
 * `base` 为 `null` 时按「新建」处理（缺字段取默认值）；给了旧记录则按「局部更新」，
 * 缺字段沿用旧值——发布开关、排序这些只传一个字段的请求因此也能复用同一套校验。
 */
export function parseWorkFields(body: unknown, base: WorkFields | null): WorkFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new WorkError(400, '请求体必须是一个对象。');
  }
  const input = body as Record<string, unknown>;

  const mode = readMode(input.mode, base?.mode ?? 'template');

  const title = readText(input.title, base?.title ?? '', MAX_TITLE, '标题');
  if (!title) throw new WorkError(400, '标题不能为空。');

  const summary = readText(input.summary, base?.summary ?? '', MAX_SUMMARY, '简介');
  const category = readText(input.category, base?.category ?? '', MAX_CATEGORY, '分类');

  const rawYear = readText(input.year, base?.year ?? '', MAX_YEAR, '年份');
  // 年份不合法时不报错，直接丢弃：这是个装饰字段，不值得为它拦下一次保存。
  const year = rawYear && YEAR_RE.test(rawYear) ? rawYear : '';

  const tags = readTags(input.tags, base?.tags ?? []);
  const repoUrl = readUrl(input.repoUrl, base?.repoUrl ?? '', '源码地址');
  const demoUrl = readUrl(input.demoUrl, base?.demoUrl ?? '', '预览地址');
  const thumbnail = readMedia(input.thumbnail, base?.thumbnail ?? '', '缩略图');
  const gallery = readGallery(input.gallery, base?.gallery ?? []);

  const readme = readLongText(input.readme, base?.readme ?? '', MAX_README_BYTES, 'README');
  const html = readLongText(input.html, base?.html ?? '', MAX_HTML_BYTES, '自定义 HTML');

  const published =
    typeof input.published === 'boolean' ? input.published : (base?.published ?? false);

  const rawOrder = input.order;
  let order: number;
  if (rawOrder === undefined) {
    order = base?.order ?? 0;
  } else if (typeof rawOrder === 'number' && Number.isFinite(rawOrder) && rawOrder >= 0) {
    order = Math.trunc(rawOrder);
  } else {
    throw new WorkError(400, 'order 必须是不小于 0 的整数。');
  }

  return {
    mode,
    title,
    summary,
    tags,
    year,
    category,
    repoUrl,
    demoUrl,
    thumbnail,
    gallery,
    // 互斥归一化：哪一侧不生效就清空，别在文件里留一份看不见的旧内容。
    readme: mode === 'template' ? readme : '',
    html: mode === 'developer' ? html : '',
    published,
    order,
  };
}

/**
 * 由标题生成 slug。
 *
 * 中文标题拉丁化不了（`normalize('NFKD')` 去不掉汉字），所以会退化成一个时间戳兜底；
 * 那个 slug 不好看，但至少能存。后台里可以手改，改完链接就固定了。
 */
export function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return ascii || `work-${Date.now().toString(36)}`;
}

/**
 * 解析最终 slug。
 *
 * 两种来源的规则不同，这是刻意的：
 *   · **作者手填**：重复就 409。自动加后缀会让人以为存的是自己填的那个，回头找不到链接；
 *   · **由标题自动生成**：重复时自动加 `-2`、`-3`，因为作者根本没关心过这个值。
 */
export function resolveSlug(
  raw: unknown,
  title: string,
  current: string | null,
  taken: ReadonlySet<string>,
  ordered: (base: string) => string,
): string {
  if (raw === undefined) {
    if (current) return current;
    return ordered(slugify(title));
  }
  const text = asString(raw);
  if (text === null) throw new WorkError(400, 'slug 必须是字符串。');
  const slug = text.trim().toLowerCase();
  if (!slug) {
    // 显式传空串 = 「按标题重新生成」。
    return ordered(slugify(title));
  }
  if (!isSlug(slug)) {
    throw new WorkError(400, 'slug 只能用小写字母、数字和连字符，且不能以连字符开头或结尾。');
  }
  if (slug === current) return slug;
  if (taken.has(slug)) throw new WorkError(409, `slug「${slug}」已经被别的作品占用了。`);
  return slug;
}
