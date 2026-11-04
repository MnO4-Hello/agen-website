/**
 * 留言里的图片。
 *
 * 与 `blog/media.ts` 同一套做法，只是换了目录（`data/message-media/`）与前缀（`m-`）：
 *
 *   · **不做回收**：删留言不删图。留言的图只有一处引用（那条留言），但「回收」需要
 *     全量扫一遍才发现没人引用，而多占几 MB 磁盘的代价远小于误删别人图的风险。
 *     与博客同理，见 `blog/media.ts:1-13`。
 *   · **文件名 = 内容哈希**：同一张图反复上传只占一份，URL 因此可以放心 `immutable`。
 *   · **只认 magic byte**：白名单在 `media/sniff-image.ts`，刻意没有 SVG。
 *
 * 与博客不同的是上限：留言是游客也能用的入口，5 MB 已经够放手机直出图；再大就该在
 * 客户端压一次（见 `apps/web/src/message/compress.ts`）。
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
import { MessageError } from './validate.js';

/** 源码在 `src/message/media.ts`、编译在 `dist/message/media.js`，两者都往上两跳。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MEDIA_DIR = path.join(API_ROOT, 'data', 'message-media');

/** 前缀 `m` 是留言专属；扩展名只认 magic byte 判出来的那五种。 */
const MEDIA_RE = /^m-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;

/** **下发**用的白名单：原图 + 两档派生图。入库校验仍只认上面那条。 */
const SERVED_MEDIA_RE = /^m-[a-f0-9]{16}(?:\.(?:png|jpg|webp|gif|avif)|-[tc]\.webp)$/;

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export const messageMediaPaths = {
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

export function isMessageMediaName(value: string): boolean {
  return MEDIA_RE.test(value);
}

/** 能不能作为图片被下发（原图或派生图）。 */
export function isServedMessageMediaName(value: string): boolean {
  return SERVED_MEDIA_RE.test(value);
}

export function messageMediaMime(name: string): string {
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

export interface SavedMessageMedia {
  /** 入库用的文件名。前端只回传它，不传 URL。 */
  name: string;
  url: string;
  mime: string;
  size: number;
}

export async function saveMedia(buffer: Buffer): Promise<SavedMessageMedia> {
  if (buffer.length === 0) throw new MessageError(400, 'validation_error', '文件是空的。');
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new MessageError(
      413,
      'validation_error',
      `图片太大了（上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB）。`,
    );
  }

  const ext: MediaExt | null = sniffImage(buffer);
  if (!ext) {
    throw new MessageError(415, 'unsupported_media', '只支持 PNG / JPEG / WebP / GIF / AVIF。');
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const name = hashedMediaName('m', buffer, ext);
  const target = messageMediaPaths.file(name);

  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buffer);
    await renameWithRetry(tmp, target);
  }

  // 两档派生图。留言图在客户端已经被压过（`message/compress.ts`），这里通常只花
  // 一两百毫秒；仍然走同一个入口，免得「客户端压过」这条前提以后被悄悄改掉。
  await ensureDerivatives(MEDIA_DIR, name, buffer);

  return {
    name,
    url: `/api/messages/media/${name}`,
    mime: mimeOfMediaName(name),
    size: buffer.length,
  };
}
