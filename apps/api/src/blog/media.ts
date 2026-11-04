/**
 * 帖子里的图片。
 *
 * 为什么单独开一个目录与前缀（`data/blog-media/` + `b-`）：作品与账号的图各自有
 * 「删记录时把没人引用的图挪进回收站」的逻辑，共用目录会让它们互相误删（详见
 * `works/store.ts` 顶部）。博客的图只有一处引用（帖子正文里的 Markdown），
 * 所以这里**不做回收**：删帖时图留在原地，宁可多占一点磁盘，也不要出现
 * 「删了一篇帖子，另一篇的图跟着没了」。
 *
 * 文件名 = 内容哈希（与作品/账号一致）：
 *   · 同一张图反复上传只占一份；
 *   · URL 因此可以放心用 `immutable` 长缓存（换图必换 URL）。
 */

import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashedMediaName,
  mimeOfMediaName,
  sniffImage,
  type MediaExt,
} from '../media/sniff-image.js';
import { ensureDerivatives } from '../media/derivatives.js';
import { BlogError } from './validate.js';

/** 源码在 `src/blog/media.ts`、编译在 `dist/blog/media.js`，两者都往上两跳。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MEDIA_DIR = path.join(API_ROOT, 'data', 'blog-media');

/** 前缀 `b` 是博客专属；扩展名只认 magic byte 判出来的那五种。 */
const MEDIA_RE = /^b-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;

/** **下发**用的白名单：原图 + 两档派生图。入库校验仍只认上面那条。 */
const SERVED_MEDIA_RE = /^b-[a-f0-9]{16}(?:\.(?:png|jpg|webp|gif|avif)|-[tc]\.webp)$/;

/** 单张图上限。与账号头像同一档：博客正文里的插图很少需要更大。 */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export const blogMediaPaths = {
  dir: MEDIA_DIR,
  file(name: string): string {
    return path.join(MEDIA_DIR, name);
  },
  /** 目录在这台机器上的真实路径（用来挡符号链接出逃）。 */
  async realDir(): Promise<string> {
    await mkdir(MEDIA_DIR, { recursive: true });
    return realpath(MEDIA_DIR);
  },
};

export function isBlogMediaName(value: string): boolean {
  return MEDIA_RE.test(value);
}

/** 能不能作为图片被下发（原图或派生图）。 */
export function isServedBlogMediaName(value: string): boolean {
  return SERVED_MEDIA_RE.test(value);
}

export function blogMediaMime(name: string): string {
  return mimeOfMediaName(name);
}

/** Windows 上 `rename` 偶尔会 EPERM（杀毒软件短暂占用目标文件），重试两次就过去了。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (attempt >= 2 || !retriable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export interface SavedBlogMedia {
  file: string;
  url: string;
  mime: string;
  size: number;
}

/**
 * 存一张图。
 *
 * **只认 magic byte，不信客户端给的扩展名**（判定逻辑在 `media/sniff-image.ts`，
 * 白名单里刻意没有 svg——带 `<script>` 的 SVG 会在本站源上执行）。
 */
export async function saveMedia(buffer: Buffer): Promise<SavedBlogMedia> {
  if (buffer.length === 0) throw new BlogError(400, 'validation_error', '文件是空的。');
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new BlogError(
      413,
      'validation_error',
      `图片太大了（上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB）。`,
    );
  }

  const ext: MediaExt | null = sniffImage(buffer);
  if (!ext) throw new BlogError(415, 'unsupported_media', '只支持 PNG / JPEG / WebP / GIF / AVIF。');

  await mkdir(MEDIA_DIR, { recursive: true });
  const file = hashedMediaName('b', buffer, ext);
  const target = blogMediaPaths.file(file);

  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buffer);
    await renameWithRetry(tmp, target);
  }

  // 两档派生图。原图已存在时这里只补缺的那一档，重复上传零额外开销。
  await ensureDerivatives(MEDIA_DIR, file, buffer);

  return { file, url: `/api/blog/media/${file}`, mime: mimeOfMediaName(file), size: buffer.length };
}
