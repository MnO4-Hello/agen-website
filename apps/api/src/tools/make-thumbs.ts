/**
 * 一次性补齐派生图（`-t.webp` / `-c.webp`）。
 *
 *   npm run thumbs --workspace @agen/api          # 开发机
 *   node apps/api/dist/tools/make-thumbs.js       # 服务器（build 之后，走同一份逻辑）
 *
 * 为什么要有这个脚本：上传时生成只覆盖「新图」。上线前已经在 `data/*-media/`
 * 里的历史图没有副本，而前端派生的 URL 是纯字符串拼接 —— 缺一份就 404 一次。
 * 补齐之后那次 404 也没有了。
 *
 * 幂等：已有副本直接跳过；按目录串行，不会把 1C2G 的 CPU 与内存打满。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivedNamesOf, ensureDerivatives } from '../media/derivatives.js';

/** 源码在 `src/tools/`、编译在 `dist/tools/`，两者都往上两跳就是 `apps/api`。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DIRS = ['blog-media', 'message-media', 'works-media', 'account-media'] as const;

/** 只处理原图；`-t` / `-c` / `.tmp` 残留全部跳过。 */
const ORIGINAL_RE = /^[a-z]-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;

function sizeOf(file: string): Promise<number> {
  return stat(file).then(
    (info) => info.size,
    () => 0,
  );
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

async function main(): Promise<void> {
  let scanned = 0;
  let made = 0;
  let skipped = 0;
  let failed = 0;
  let before = 0;
  let after = 0;

  for (const dirName of DIRS) {
    const dir = path.join(API_ROOT, 'data', dirName);

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      console.log(`－ ${dirName}：目录不存在，跳过`);
      continue;
    }

    console.log(`▶ ${dirName}（${entries.length} 个条目）`);

    for (const name of entries.sort()) {
      if (!ORIGINAL_RE.test(name)) continue;
      scanned += 1;

      const missing: string[] = [];
      for (const derived of derivedNamesOf(name)) {
        if ((await sizeOf(path.join(dir, derived))) === 0) missing.push(derived);
      }
      if (missing.length === 0) {
        skipped += 1;
        continue;
      }

      const originalPath = path.join(dir, name);
      try {
        const buffer = await readFile(originalPath);
        await ensureDerivatives(dir, name, buffer);

        const produced = (
          await Promise.all(missing.map((derived) => sizeOf(path.join(dir, derived))))
        ).reduce((sum, size) => sum + size, 0);

        if (produced === 0) {
          failed += 1;
          console.warn(`✗ ${name}：一份副本都没生成（可能超像素上限或文件损坏）`);
          continue;
        }

        made += missing.length;
        before += buffer.length;
        after += produced;
        console.log(
          `  ✓ ${name} → ${missing.join(' + ')}` +
            `（原图 ${kb(buffer.length)} → 副本 ${kb(produced)}）`,
        );
      } catch (error) {
        failed += 1;
        console.warn(`✗ ${name}：${(error as Error).message}`);
      }
    }
  }

  console.log(
    `\n扫描 ${scanned} 张原图 / 生成 ${made} 份副本 / 已有 ${skipped} / 失败 ${failed}\n` +
      `参与统计的原图合计 ${(before / 1024 / 1024).toFixed(2)} MB，` +
      `对应副本合计 ${(after / 1024 / 1024).toFixed(2)} MB`,
  );
}

main().catch((error: unknown) => {
  console.error(`✗ 补齐失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
