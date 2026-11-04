/**
 * 派生图：每张原图额外生成两份压缩过的 WebP，**原图一个字节都不动**。
 *
 *   b-<sha1前16>.png        原图（入库、校验、永久保留）
 *   b-<sha1前16>-t.webp     长边 ≤ 512，quality 78 —— 头像 / 列表卡 / 图集格子
 *   b-<sha1前16>-c.webp     长边 ≤ 1920，quality 80 —— 正文插图 / 详情横幅
 *
 * 三条纪律，改这个文件之前先读一遍：
 *
 *   1. **后缀即契约**。前端 `shared/media.ts` 直接把原图名改写成这两个后缀，
 *      不查表、不入库。所以 quality / edge 一旦发布就冻结；要调参数就换后缀
 *      （`-t2`），否则浏览器里 `immutable` 缓存的旧字节永远不会被替换。
 *
 *   2. **压缩是优化，不是功能**。sharp 抛任何错（坏文件、超像素上限、libvips
 *      抽风）都只吞掉并打一行 warn，原图照常入库——前端 `createMediaImage()`
 *      的 onerror 会退回原图，用户完全无感。
 *
 *   3. **全局串行**。1C2G × 单进程，同时跑两条 libvips 流水线就是 OOM 的最短路径。
 *
 * 为什么不做「压缩后确实更小才写」的判断：前端派生的 URL 是纯字符串拼接，
 * 缺文件就会稳定 404；而 404 循环的代价（每次刷新一次额外往返）比多存几十 KB
 * 更高。唯一可能变大的场景是「已经是 WebP 的图再压一次」，那种图本身就不大。
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

export const THUMB_EDGE = 512;
export const CONTENT_EDGE = 1920;
export const THUMB_QUALITY = 78;
export const CONTENT_QUALITY = 80;

/**
 * 解码像素上限。36MP 的 RGBA 约 144MB，加上 Node 常驻 ~90MB 与输入 buffer，
 * 正好卡在 `ecosystem.config.cjs` 里 768M 的可用区间内。超过这个值的图直接
 * 放弃压缩，不阻断上传。
 */
const LIMIT_INPUT_PIXELS = 36_000_000;

// libvips 默认按 CPU 核数开线程池；1 核机器上并发只会把 RSS 顶上去，不会更快。
sharp.concurrency(1);
// 缓存默认会留 50MB 起的解码头；这个站一天几十张图，缓存一分钱都不值。
sharp.cache(false);

export type DerivativeTier = 't' | 'c';

export interface DerivativeImage {
  readonly name: string;
  readonly data: Buffer;
}

/** 原图名：`<prefix>-<sha1 前 16 位>.<png|jpg|webp|gif|avif>`。 */
const ORIGINAL_RE = /^([a-z])-([a-f0-9]{16})\.(png|jpg|webp|gif|avif)$/;

/** 派生图名：只可能是 WebP。 */
const DERIVATIVE_RE = /^[a-z]-[a-f0-9]{16}-[tc]\.webp$/;

export function isDerivativeName(value: string): boolean {
  return DERIVATIVE_RE.test(value);
}

export function derivedName(originalName: string, tier: DerivativeTier): string | null {
  const match = ORIGINAL_RE.exec(originalName);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${tier}.webp`;
}

/** `['w-abc-t.webp', 'w-abc-c.webp']`；名字不是本站命名时返回空数组。 */
export function derivedNamesOf(originalName: string): string[] {
  const names: string[] = [];
  for (const tier of ['t', 'c'] as const) {
    const name = derivedName(originalName, tier);
    if (name) names.push(name);
  }
  return names;
}

/* ---------------------------------------------------------------------------
   串行队列（与 works/store.ts 里那套同构：前一个失败也继续，别让队列永久卡死）
--------------------------------------------------------------------------- */

let chain: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Windows 上 `rename` 偶尔 EPERM（杀软短暂占用目标），重试两次就过去了。 */
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

/* ---------------------------------------------------------------------------
   渲染
--------------------------------------------------------------------------- */

interface Preset {
  readonly tier: DerivativeTier;
  readonly edge: number;
  readonly quality: number;
}

const PRESETS: readonly Preset[] = [
  { tier: 't', edge: THUMB_EDGE, quality: THUMB_QUALITY },
  { tier: 'c', edge: CONTENT_EDGE, quality: CONTENT_QUALITY },
];

function renderOne(input: Buffer, preset: Preset): Promise<Buffer> {
  return serial(async () =>
    sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: 'error' })
      /*
       * 按 EXIF 摆正（手机拍的竖图不 `rotate()` 会躺倒）。
       * 之后再没调用 `withMetadata()`，所以 EXIF / ICC / XMP 全部被丢掉——
       * 既省字节，也避免把拍摄地这类信息带到公网上。
       */
      .rotate()
      .resize({
        width: preset.edge,
        height: preset.edge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      /*
       * 动图（GIF / 动图 WebP）默认只取首帧。不开 `animated: true` 的理由：
       * 那会把整段动画解码进内存，几 MB 的 GIF 在 1C2G 上能顶到几百 MB；
       * 而原图页展示的仍是原图，动画一点没丢。与前端 `message/compress.ts`
       * 对 GIF 的处理语义一致。
       */
      .webp({ quality: preset.quality, effort: 4 })
      .toBuffer(),
  );
}

/**
 * 渲染缺失的那几档，**不落盘**。
 *
 * 作品上传那条路径必须在 `exclusive()` 队列之外调用它（渲染几百毫秒到几秒，
 * 而那条队列同时给 works.json 的读改写排队）。
 */
export async function buildDerivatives(
  dir: string,
  originalName: string,
  buffer: Buffer,
): Promise<DerivativeImage[]> {
  const out: DerivativeImage[] = [];

  for (const preset of PRESETS) {
    const name = derivedName(originalName, preset.tier);
    if (!name) return [];
    // 幂等：同一张图重复上传 / 补齐脚本重跑，都只补缺的那一档。
    if (await exists(path.join(dir, name))) continue;
    try {
      out.push({ name, data: await renderOne(buffer, preset) });
    } catch (error) {
      console.warn(`[media] 生成 ${name} 失败，已跳过：${(error as Error).message}`);
    }
  }

  return out;
}

export async function writeDerivatives(
  dir: string,
  items: readonly DerivativeImage[],
): Promise<void> {
  if (items.length === 0) return;
  await mkdir(dir, { recursive: true });

  for (const item of items) {
    const target = path.join(dir, item.name);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, item.data);
    await renameWithRetry(tmp, target);
  }
}

/** 一步到位：查缺 → 渲染 → 原子落盘。三个不在队列里的上传点都用这个。 */
export async function ensureDerivatives(
  dir: string,
  originalName: string,
  buffer: Buffer,
): Promise<void> {
  await writeDerivatives(dir, await buildDerivatives(dir, originalName, buffer));
}
