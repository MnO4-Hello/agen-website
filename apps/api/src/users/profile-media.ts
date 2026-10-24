/**
 * 账号媒体（头像 / 主页封面 / 主页背景）的存储。
 *
 * **为什么单独一个目录，不复用作品那套 `works-media/`**：
 * `removeWork()` 会把「不再被任何作品引用」的媒体 move 进 `.admin-trash/`。头像
 * 如果落在同一个目录、又碰巧和某张作品封面是同一张图（文件名是内容哈希，会去重），
 * 删作品就会顺手把头像挪走。目录独立 + 前缀独立 + 路由独立，这类耦合就整类消失。
 *
 * 其余纪律与作品媒体一致：内容哈希命名（同图只存一份，URL 可 `immutable` 长缓存）、
 * 只信 magic byte（白名单见 `media/sniff-image.ts`）、临时文件 + rename 原子落盘。
 */

import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_MEDIA_PREFIX, ACCOUNT_MEDIA_RE } from './profile-types.js';
import { hashedMediaName, MEDIA_HINT, mimeOfMediaName, sniffImage } from '../media/sniff-image.js';
import { UserError } from './validate.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'account-media');

export const accountMediaPaths = {
  dir: MEDIA_DIR,
  file(name: string): string {
    return path.join(MEDIA_DIR, name);
  },
  /** 容器路径在这台机器上的真实路径（用来挡符号链接出逃）。 */
  async realDir(): Promise<string> {
    await mkdir(MEDIA_DIR, { recursive: true });
    return realpath(MEDIA_DIR);
  },
};

export function isAccountMediaName(value: string): boolean {
  return ACCOUNT_MEDIA_RE.test(value);
}

export function accountMediaMime(name: string): string {
  return mimeOfMediaName(name);
}

/** 内容哈希命名的 URL → 文件名；不是本站命名就返回 null。 */
export function accountMediaNameFromUrl(url: string): string | null {
  if (!url.startsWith(ACCOUNT_MEDIA_PREFIX)) return null;
  const name = url.slice(ACCOUNT_MEDIA_PREFIX.length);
  return ACCOUNT_MEDIA_RE.test(name) ? name : null;
}

/**
 * Windows 上 rename 偶尔会因为被杀软/索引器短暂占用而 EPERM。
 * 与 `works/store.ts` 里那份是同一个补丁——这里没有共享的 util 层，
 * 复制 12 行比为一个函数去动核心模块更划算。
 */
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

export interface SavedAccountMedia {
  file: string;
  url: string;
  mime: string;
  size: number;
}

export async function saveAccountMedia(buffer: Buffer): Promise<SavedAccountMedia> {
  if (buffer.length === 0) {
    throw new UserError(400, 'invalid_body', '没有收到图片内容。');
  }
  const ext = sniffImage(buffer);
  if (!ext) {
    throw new UserError(415, 'unsupported_image', MEDIA_HINT);
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const file = hashedMediaName('a', buffer, ext);
  const target = accountMediaPaths.file(file);

  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buffer);
    await renameWithRetry(tmp, target);
  }

  return {
    file,
    url: `${ACCOUNT_MEDIA_PREFIX}${file}`,
    mime: mimeOfMediaName(file),
    size: buffer.length,
  };
}
