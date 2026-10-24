/**
 * 生成 `apps/web/public/portrait-{1024,512}.png` 的两张占位头像。
 *
 * 为什么手写 PNG 编码而不是用图形库：这个仓库**没有任何图像处理依赖**，
 * 加一个 sharp / canvas 只为生成两张常驻不变的小图不值得（还会拖慢 install）。
 * PNG 的容器格式很简单：IHDR + IDAT（zlib 压缩的扫描线）+ IEND，
 * Node 内置 `zlib` 已经提供了 deflate，剩下的只是 CRC32 与分块拼装。
 *
 * 为什么这么画：这两张图会被 `scene/portrait-points.ts` 切成点阵再逐点取色
 * （规则是「每格保留离该格平均色最远的像素」）。所以画面必须是**硬边缘、高对比**——
 * 柔和的渐变会让整格都接近均值，点阵就糊成一团，看不出形状。
 * 这里用「近白的头肩剪影 + 深绿渐变底 + 铜色光环」正是为了让每一格的边界都咬得住。
 *
 * 用法：
 *   node tools/make-portrait.mjs
 * 想换掉占位图：直接用自己的正方形头像覆盖这两张文件即可（尺寸必须保持
 * 1024×1024 与 512×512，点阵采样按方图切格）。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'apps/web/public');
const SIZES = [1024, 512];

/** 站点主题色（与 styles.css 的 --brand / --brand-strong / CTA 的 flare 同源）。 */
const BG_TOP = [18, 41, 28];
const BG_BOTTOM = [36, 71, 52];
const GLOW = [47, 98, 68];
const INK = [231, 242, 230];
const ACCENT = [198, 132, 66];

/** 一颗四角星：中心 + 半径（都是归一化到画布边长的比例）。 */
const STARS = [
  [0.3, 0.22, 0.016],
  [0.72, 0.3, 0.012],
  [0.63, 0.12, 0.01],
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 超采样：每个像素被拆成 N×N 个子样本，边缘因此得到干净的抗锯齿。 */
const SUB = 4;

/**
 * 画布上的一个连续坐标点返回颜色。`u` / `v` 是 0~1 的归一化坐标（左上角为原点），
 * 这样 1024 与 512 用同一套参数、各自按比例渲染（而不是把 1024 缩成 512，缩图会把边缘糊掉）。
 */
function shade(u, v) {
  // 1) 竖向渐变底
  let color = mix(BG_TOP, BG_BOTTOM, v);

  // 2) 中央光晕：smoothstep 衰减，让胸像背后有一团微光
  const gd = Math.hypot(u - 0.5, v - 0.42) / 0.46;
  if (gd < 1) {
    const t = 1 - gd;
    const s = t * t * (3 - 2 * t) * 0.55;
    color = mix(color, GLOW, clamp01(s));
  }

  // 3) 铜色光环：绕着头、在剪影外侧
  const hd = Math.hypot(u - 0.5, v - 0.4);
  const ringR = 0.178;
  if (Math.abs(hd - ringR) < 0.004) color = mix(color, ACCENT, 0.85);

  // 4) 头肩剪影：圆头 + 短颈 + 椭圆肩，连成一段胸像
  const head = hd < 0.145;
  const neck = Math.abs(u - 0.5) < 0.058 && v > 0.45 && v < 0.68;
  const shoulder = ((u - 0.5) / 0.35) ** 2 + ((v - 0.9) / 0.29) ** 2 < 1;
  if (head || neck || shoulder) color = INK;

  // 5) 三颗四角星（astroid：|x|^0.5 + |y|^0.5 <= r^0.5）
  for (const [sx, sy, sr] of STARS) {
    const dx = Math.abs(u - sx) / sr;
    const dy = Math.abs(v - sy) / sr;
    if (Math.sqrt(dx) + Math.sqrt(dy) <= 1) color = ACCENT;
  }

  return color;
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const step = 1 / size;
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // 每行的 filter type：0 = None（数据量大但不用做 undo 预测，简单可靠）
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUB; sy += 1) {
        const v = (y + (sy + 0.5) / SUB) * step;
        for (let sx = 0; sx < SUB; sx += 1) {
          const u = (x + (sx + 0.5) / SUB) * step;
          const c = shade(u, v);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SUB * SUB;
      raw[offset] = Math.round(r / n);
      raw[offset + 1] = Math.round(g / n);
      raw[offset + 2] = Math.round(b / n);
      raw[offset + 3] = 255; // 全不透明：点阵采样会跳过透明像素，留白没有意义
      offset += 4;
    }
  }
  return raw;
}

// ── 最小 PNG 编码器 ────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  const file = join(OUT_DIR, `portrait-${size}.png`);
  writeFileSync(file, png);
  console.log(`${file}  ${size}x${size}  ${(png.length / 1024).toFixed(1)}KB`);
}
