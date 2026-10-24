/**
 * 图片类型的**唯一**判定点：只认 magic byte，不信客户端给的扩展名与 content-type。
 *
 * 为什么单独抽一个模块：作品的媒体（`works/store.ts`）与账号的头像/封面
 * （`users/profile-media.ts`）用的是同一套白名单，两边各抄一份迟早会分叉——
 * 补白名单时漏掉一边，那一半就悄悄允许了不该允许的格式。
 *
 * **白名单里没有 svg、没有 html**。这不是保守：一份带 `<script>` 的 SVG 被当成图片
 * 存进我们的源，绕过 `<img>` 直接访问那个 URL 时脚本就在本站的源上跑了。
 */

import { createHash } from 'node:crypto';

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
} as const;

export type MediaExt = keyof typeof MIME_BY_EXT;

/** 415 时给用户看的那一句，三处上传共用，免得文案分叉。 */
export const MEDIA_HINT = '只支持 PNG / JPEG / WebP / GIF / AVIF 图片。';

export function sniffImage(buffer: Buffer): MediaExt | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
    ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'))
  ) {
    return 'avif';
  }
  return null;
}

/** 文件名 → MIME。名字不是我们生成的时候返回 octet-stream（配合 nosniff 是安全的）。 */
export function mimeOfMediaName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1) as MediaExt;
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 内容哈希命名：同一张图反复上传只占一份，URL 也因此可以放心用 `immutable` 长缓存。 */
export function hashedMediaName(prefix: string, buffer: Buffer, ext: MediaExt): string {
  return `${prefix}-${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}.${ext}`;
}
