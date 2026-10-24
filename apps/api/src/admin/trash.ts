/**
 * 删东西的回收站。
 *
 * 与 `routes/admin-files.ts` 同一套策略：**删除 = `rename` 到 `.admin-trash/<时间戳>/<分组>/`**。
 * 不 `rm` 的理由很实际——误删能从磁盘上找回来，而且 `rename` 在文件被占用时会失败而不是
 * 删掉一半。
 *
 * 单独抽一个文件（而不是从 admin-files.ts 里 import）：那个文件的核心价值是**白名单 +
 * 路径归一化**这一整套安全边界，作品模块不需要它、也不该因为「借一个常量」而和它耦合。
 */

import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根。
 *
 * `src/admin/trash.ts` 往上四层是仓库根；编译到 `dist/admin/trash.js` 后层数相同，
 * 所以同一个表达式在两种形态下都成立。
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const TRASH_DIR = path.join(REPO_ROOT, '.admin-trash');

/** `2026-10-23T13-05-04`——目录名里不能有冒号（Windows 会直接拒绝）。 */
export function trashStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 把文件挪进回收站，返回相对仓库根的 posix 路径（给前端显示用）。
 *
 * 失败（文件不在了、跨设备、被占用）返回 `null`：一次删除里某个媒体挪不动，
 * 不该让整次删除失败——记录已经从索引里摘掉了，那才是用户想看到的结果。
 */
export async function moveToTrash(from: string, group: string, stamp: string): Promise<string | null> {
  const target = path.join(TRASH_DIR, group, stamp, path.basename(from));
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await rename(from, target);
    return path.relative(REPO_ROOT, target).split(path.sep).join('/');
  } catch {
    return null;
  }
}
