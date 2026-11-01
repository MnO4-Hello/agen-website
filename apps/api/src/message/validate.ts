/**
 * 留言 / 回复的校验与归一化。
 *
 * 与 `blog/validate.ts` 同一套原则：不「尽力修正」、长度与数量都有上限、能力边界写在
 * 长度上（触到上限不是 bug，是「该换数据库了」的信号）。
 *
 * 两条留言板特有的规矩：
 *
 *   1. **图片是「文件名 + 白名单正则」**，不接受完整 URL。前端只回传 `m-<hash>.<ext>`，
 *      服务端拼前缀——否则一条留言就能引用站外资源，或者把自己伪装成别处的路径。
 *   2. **允许「只有图、没有字」**。留言板的图本身就是内容，硬要求配文反而逼人写废话。
 */

import type { MessageMode } from './types.js';

/** 带 HTTP 状态码与机器码的业务错误，路由层统一转成 `{ error, message }`。 */
export class MessageError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MessageError';
  }
}

export const MAX_TEXT_LENGTH = 2000;
export const MAX_MARKDOWN_LENGTH = 8000;
export const MAX_IMAGES = 4;
/** 一条纯文本留言里最多几个链接（再多基本就是引流的机器文）。 */
export const MAX_TEXT_LINKS = 3;
/** Markdown 模式放宽：写技术留言时贴三五个链接很正常。 */
export const MAX_MARKDOWN_LINKS = 8;

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 30;

/** 能力边界：到这个量级就该换 SQLite 了。 */
export const MAX_MESSAGES = 5000;
export const MAX_REPLIES_PER_MESSAGE = 300;

/** 上传时的图片文件名（服务端用内容哈希生成，这里是复核）。 */
const IMAGE_NAME_RE = /^m-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;
/** Markdown 正文里允许引用的图片：只认本模块的直链。 */
export const MARKDOWN_IMAGE_PREFIX = '/api/messages/media/';

/**
 * 除换行与制表符外的控制字符一律拒绝（零宽字符、方向控制符也在里面）。
 *
 * 零宽字符是「看起来一样、实际不同」的免费工具：用来绕过同文去重，或者把链接伪装成
 * 另一段文字。纯文本场景没有一条正当理由需要它们。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029]/;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function queryValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function tooLong(length: number, max: number): never {
  throw new MessageError(400, 'validation_error', `最多 ${max} 个字（现在 ${length} 个）。`);
}

function countLinks(text: string): number {
  return (text.match(/https?:\/\//g) ?? []).length;
}

/** 从 Markdown 里抽出图片引用地址（只在服务端校验时用，不需要完整解析器）。 */
export function markdownImageTargets(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   图片
--------------------------------------------------------------------------- */

/**
 * 图片文件名列表。
 *
 * 去重而不是报错：用户重复选同一张图是很自然的手滑，扔掉重复项比让他重来友好。
 * 但**超过 4 张要报错**——悄悄截断会让用户以为图都发出去了。
 */
function parseImages(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MessageError(400, 'validation_error', 'images 必须是数组。');
  }
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!IMAGE_NAME_RE.test(name)) {
      throw new MessageError(400, 'validation_error', '图片引用不合法，重新上传一次试试。');
    }
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > MAX_IMAGES) {
    throw new MessageError(400, 'validation_error', `一条留言最多 ${MAX_IMAGES} 张图。`);
  }
  return names;
}

/* ---------------------------------------------------------------------------
   留言
--------------------------------------------------------------------------- */

export interface MessageFields {
  mode: MessageMode;
  body: string;
  images: string[];
}

export interface ParseOptions {
  /** 回复恒为纯文本：`false` 时拒绝 markdown，并且忽略 mode 字段。 */
  allowMarkdown: boolean;
}

export function parseMessageFields(raw: unknown, options: ParseOptions): MessageFields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MessageError(400, 'validation_error', '请求体必须是一个对象。');
  }
  const input = raw as Record<string, unknown>;

  let mode: MessageMode = 'text';
  if (options.allowMarkdown) {
    const rawMode = input.mode;
    if (rawMode !== undefined && rawMode !== null && rawMode !== 'text' && rawMode !== 'markdown') {
      throw new MessageError(400, 'validation_error', 'mode 只能是 text 或 markdown。');
    }
    mode = rawMode === 'markdown' ? 'markdown' : 'text';
  }

  const rawBody = asString(input.body);
  if (rawBody === null) {
    throw new MessageError(400, 'validation_error', '内容必须是字符串。');
  }
  const body = rawBody.replace(/\r\n?/g, '\n').trim();
  if (CONTROL_CHARS.test(body)) {
    throw new MessageError(400, 'validation_error', '内容里有不可见字符，去掉再试。');
  }

  if (mode === 'markdown') {
    return parseMarkdownBody(body);
  }

  const images = parseImages(input.images);
  const length = Array.from(body).length;
  if (length === 0 && images.length === 0) {
    throw new MessageError(400, 'validation_error', '写点什么，或者至少放一张图。');
  }
  if (length > MAX_TEXT_LENGTH) tooLong(length, MAX_TEXT_LENGTH);
  if (countLinks(body) > MAX_TEXT_LINKS) {
    throw new MessageError(400, 'too_many_links', `一条留言里最多放 ${MAX_TEXT_LINKS} 个链接。`);
  }
  return { mode, body, images };
}

/**
 * Markdown 模式的正文。
 *
 * 图片唯一合法的形态是 `![](/api/messages/media/m-xxx.png)`——**站外图一律不认**。
 * 不是洁癖：公开 UGC 里的外链图等于给第三方一个「谁看过这条留言」的探针，还会把
 * 页面变成任意图床的代理。正文里的外链图在前端渲染时也会被降级成普通链接（见
 * `apps/web/src/message/card.ts` 的白名单后处理），这里是第一道。
 */
function parseMarkdownBody(body: string): MessageFields {
  const length = Array.from(body).length;
  if (length < 2) {
    throw new MessageError(400, 'validation_error', '至少写两个字，或者至少放一张图。');
  }
  if (length > MAX_MARKDOWN_LENGTH) tooLong(length, MAX_MARKDOWN_LENGTH);
  if (countLinks(body) > MAX_MARKDOWN_LINKS) {
    throw new MessageError(
      400,
      'too_many_links',
      `一条留言里最多放 ${MAX_MARKDOWN_LINKS} 个链接。`,
    );
  }

  const targets = markdownImageTargets(body);
  if (targets.length > MAX_IMAGES) {
    throw new MessageError(400, 'validation_error', `一条留言最多 ${MAX_IMAGES} 张图。`);
  }
  for (const target of targets) {
    const name = target.startsWith(MARKDOWN_IMAGE_PREFIX)
      ? target.slice(MARKDOWN_IMAGE_PREFIX.length)
      : '';
    if (!IMAGE_NAME_RE.test(name)) {
      throw new MessageError(
        400,
        'validation_error',
        '正文里的图片只能引用本站上传的图（站外图请直接贴链接）。',
      );
    }
  }

  return { mode: 'markdown', body, images: [] };
}

/* ---------------------------------------------------------------------------
   查询参数
--------------------------------------------------------------------------- */

export interface MessageQuery {
  limit: number;
  cursor: string;
}

export function parseMessageQuery(raw: Record<string, unknown>): MessageQuery {
  return {
    limit: clampInt(queryValue(raw.limit), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    cursor: queryValue(raw.cursor),
  };
}

export interface AdminMessageQuery extends MessageQuery {
  /** 空串 = 全部。 */
  status: '' | 'visible' | 'hidden';
  q: string;
}

export function parseAdminMessageQuery(raw: Record<string, unknown>): AdminMessageQuery {
  const status = queryValue(raw.status);
  return {
    limit: clampInt(queryValue(raw.limit), 20, 1, 60),
    cursor: queryValue(raw.cursor),
    status: status === 'visible' || status === 'hidden' ? status : '',
    // 搜索词截断到 80：更长的词没人用，但会让每次比较都变慢。
    q: Array.from(queryValue(raw.q)).slice(0, 80).join(''),
  };
}

/** 后台接口里的 id：形状先挡一道，顺便避免拼出奇怪的日志行。 */
export function readId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 64 || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new MessageError(404, 'not_found', '没有这条留言。');
  }
  return id;
}

export function isImageName(value: string): boolean {
  return IMAGE_NAME_RE.test(value);
}
