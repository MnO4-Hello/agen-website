/**
 * 6 个 AI 品牌的 logo —— 「字符点阵」场景（scene/ai-lab.ts）的取形来源。
 *
 * 做法照搬 https://www.bilibili.com/toy/wujisuan-ai-test/ ：把 logo 图**在运行时**
 * 栅格化成一张「墨量」蒙版（Float32Array），再在画布上按格子采样，每个落进图形
 * 内部的格子放一个字符——大部分格子放该品牌的**首字母**（OpenAI 一片 O、Claude
 * 一片 C……），边缘稀疏处换成 `+`，另有少量 `#` / `*` 按确定性散列点缀，让疏密过渡
 * 自然。所以远处看是图形，近处看是一片字符。
 *
 * 蒙版有三种取法（见 AiLogo.mask）：
 *   - `alpha`：直接用透明通道当墨量。OpenAI / Grok / Cognition 的画是「黑图 + 透明
 *     底」，Claude 是不透明橙色，MiMo 是不透明深灰——这五家看 alpha 都对。
 *   - `light` / `dark`：改用亮度当墨量。StepFun 是一整块不透明黑圆里挖出白格子，
 *     无论只看 alpha（得到一坨死圆）还是只看白格子（只剩几块游离的方块）都不像，
 *     要的是「圆盘挖方孔」，所以走 `dark`——暗的地方算墨，白格子自然成了洞。
 *
 * 素材都在 `apps/web/public/skills/ai/` 下（换成同名文件即可替换），运行时不存在
 * 跨域问题，`getImageData` 能直接读。这些图形是各自品牌方的商标，此处仅作个人
 * 作品集里的**示意**用途，不代表任何隶属或背书关系。
 */

export interface AiLogo {
  /** 语义 id（不渲染，仅供调试与无障碍标注）。 */
  readonly id: string;
  /** 品牌名（仅调试用）。 */
  readonly name: string;
  /** 点阵里大面积重复的那个字符——取品牌首字母，远看才认得出是谁。 */
  readonly glyph: string;
  /** 取墨量的方式。 */
  readonly mask: 'alpha' | 'light' | 'dark';
  /** 相对站点根的资源路径（和 content/skills.ts 里的图片同一套写法）。 */
  readonly src: string;
}

/** 播放顺序 = 数组顺序，走到头再回到第一个，无限循环。 */
export const AI_LOGOS: readonly AiLogo[] = [
  { id: 'openai', name: 'OpenAI', glyph: 'O', mask: 'alpha', src: './skills/ai/openai.png' },
  { id: 'cognition', name: 'Cognition', glyph: 'S', mask: 'alpha', src: './skills/ai/cognition.png' },
  { id: 'stepfun', name: 'StepFun', glyph: 'S', mask: 'dark', src: './skills/ai/stepfun.svg' },
  { id: 'grok', name: 'Grok', glyph: 'G', mask: 'alpha', src: './skills/ai/grok.png' },
  { id: 'claude', name: 'Claude', glyph: 'C', mask: 'alpha', src: './skills/ai/claude.svg' },
  { id: 'mimo', name: 'MiMo', glyph: 'M', mask: 'alpha', src: './skills/ai/mimo.svg' },
];

/** 栅格化的长边（px）。再大也只是喂给阈值，512 已足够保住细笔画。 */
const RASTER = 512;
/** 判定「这里有笔画」的墨量阈值——低于它的格子视为空白。 */
const INK_FLOOR = 0.2;

export interface LogoMask {
  /** 每像素墨量，0..1，长度 = width × height。 */
  readonly ink: Float32Array;
  readonly width: number;
  readonly height: number;
  /** 墨迹包围盒（栅格化坐标系）。各 logo 在画布里的留白不同，按它裁齐再缩放，
   *  六个图形看起来才会一样大。 */
  readonly left: number;
  readonly top: number;
  readonly bw: number;
  readonly bh: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 同一个 logo 只解码一次（`src + mask` 作键）。 */
const maskCache = new Map<string, Promise<LogoMask>>();

function decode(logo: AiLogo): Promise<LogoMask> {
  return new Promise<LogoMask>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = RASTER / Math.max(image.naturalWidth, image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));

        const raster = document.createElement('canvas');
        raster.width = width;
        raster.height = height;
        const ctx = raster.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          reject(new Error('no 2d context for logo mask'));
          return;
        }
        ctx.drawImage(image, 0, 0, width, height);

        const rgba = ctx.getImageData(0, 0, width, height).data;
        const ink = new Float32Array(width * height);
        let left = width;
        let top = height;
        let right = -1;
        let bottom = -1;

        for (let i = 0; i < ink.length; i += 1) {
          const alpha = rgba[i * 4 + 3] / 255;
          const luma =
            (rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722) /
            255;
          const value =
            logo.mask === 'light'
              ? alpha * clamp01((luma - 0.5) * 2)
              : logo.mask === 'dark'
                ? alpha * clamp01((0.5 - luma) * 2)
                : alpha;
          ink[i] = value;
          if (value > INK_FLOOR) {
            const x = i % width;
            const y = (i - x) / width;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }

        if (right < 0 || bottom < 0) {
          reject(new Error(`empty logo mask: ${logo.id}`));
          return;
        }
        resolve({ ink, width, height, left, top, bw: right - left + 1, bh: bottom - top + 1 });
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error(`logo failed to load: ${logo.src}`));
    image.src = logo.src;
  });
}

/**
 * 取 logo 的墨量蒙版。同一个 logo 反复取只解码一次。
 *
 * 失败（图挂了 / 是被污染的画布）时 reject——调用方负责跳过这一个 logo。
 */
export function loadLogoMask(logo: AiLogo): Promise<LogoMask> {
  const key = `${logo.src}:${logo.mask}`;
  const hit = maskCache.get(key);
  if (hit) return hit;
  const job = decode(logo);
  maskCache.set(key, job);
  return job;
}

/** 点阵里的一颗字符。坐标是**画布 CSS px**（不是归一化坐标）。 */
export interface ShapePoint {
  readonly x: number;
  readonly y: number;
  /** 基础不透明度：墨量越足越实。 */
  readonly alpha: number;
  /** 这颗粒子当前该画哪个字符。 */
  readonly glyph: string;
  /** 确定性散列种子，用来决定配对的先后与 `#` / `*` 落在哪。 */
  readonly seed: number;
}

/** 采样时每个格子内取 3×3 个点求平均——不然细笔画和镂空会被整格吞掉。 */
const SUPERSAMPLE = [-0.24, 0, 0.24];
/** 图形在画布里占的比例：宽度最多 84%、高度最多 78%。 */
const FILL_X = 0.84;
const FILL_Y = 0.78;
/** 墨量低于此值的格子不出字（滤掉抗锯齿灰边）。 */
const CELL_INK_FLOOR = 0.23;
/** 墨量低于此值的格子用 `+` 顶替品牌字母：边缘虚一点，形状反而更清楚。 */
const PLUS_CEILING = 0.55;

/**
 * 把一个 logo 采样成一组字符点。
 *
 * @param mask   loadLogoMask 的结果
 * @param logo   取 glyph
 * @param w,h    画布 CSS 尺寸
 * @param cell   格距（CSS px），由场景按画布大小算好
 */
export function buildLogoShape(
  mask: LogoMask,
  logo: AiLogo,
  w: number,
  h: number,
  cell: number,
): ShapePoint[] {
  const scale = Math.min((w * FILL_X) / mask.bw, (h * FILL_Y) / mask.bh);
  if (!(scale > 0)) return [];

  const width = mask.bw * scale;
  const height = mask.bh * scale;
  const x0 = (w - width) / 2;
  const y0 = (h - height) / 2;

  const points: ShapePoint[] = [];
  for (let y = cell / 2; y < h; y += cell) {
    for (let x = cell / 2; x < w; x += cell) {
      const u = (x - x0) / scale + mask.left;
      const v = (y - y0) / scale + mask.top;
      if (u < mask.left || u >= mask.left + mask.bw || v < mask.top || v >= mask.top + mask.bh) {
        continue;
      }

      let ink = 0;
      for (const dx of SUPERSAMPLE) {
        for (const dy of SUPERSAMPLE) {
          // 偏移量是画布像素，要除以 scale 换回栅格像素。
          const sx = Math.round(u + (dx * cell) / scale);
          const sy = Math.round(v + (dy * cell) / scale);
          if (sx >= 0 && sx < mask.width && sy >= 0 && sy < mask.height) {
            ink += mask.ink[sy * mask.width + sx] / 9;
          }
        }
      }
      if (ink < CELL_INK_FLOOR) continue;

      const seed = (Math.round(x / cell) * 127 + Math.round(y / cell) * 43) % 101;
      const glyph =
        ink < PLUS_CEILING
          ? '+'
          : seed % 11 === 0
            ? '#'
            : seed % 9 === 0
              ? '*'
              : logo.glyph;

      points.push({ x, y, alpha: 0.72 + ink * 0.28, glyph, seed });
    }
  }
  return points;
}

/** 一次形变的配对：`from` 是某颗字符的起点，`to` 是它的终点。 */
export interface MorphPair {
  readonly fromX: number;
  readonly fromY: number;
  readonly fromA: number;
  readonly fromGlyph: string;
  readonly toX: number;
  readonly toY: number;
  readonly toA: number;
  readonly toGlyph: string;
  /** 错峰：按目标 x 从左到右依次起步，整块形变才像一道扫过去的波。 */
  readonly delay: number;
  /** 弧高：让路径鼓出去一点，比直线走过去有生气。 */
  readonly bend: number;
}

const maxBend = 12;
const bendScale = 0.05;
/** 错峰最多占整段时长的比例。 */
const MAX_DELAY = 0.13;

/**
 * 把「当前这一帧的点」与「下一个图形的点」配对。
 *
 * 策略是**就近认领**（贪心最近邻），而不是按极角或行序统一排序：按序配对会让
 * 整块图形平移/旋转，像被推着走；就近认领则保留字符各自的身份，只有真正需要
 * 挪位置的才挪，观感是「各自就近归位」。
 *
 * 为了不让贪心退化成 O(n×m)，起点先按格距丢进桶里，认领时从目标格开始一圈圈
 * 向外找，第一个非空圈里取最近的那颗就是答案——通常第 0～1 圈就命中。
 *
 * 目标点多出来的部分：从下方 `cell * 2` 处淡入；起点多出来的部分：向上淡出。
 */
export function pairShapes(
  from: readonly ShapePoint[],
  to: readonly ShapePoint[],
  w: number,
  h: number,
  cell: number,
): MorphPair[] {
  const pairs: MorphPair[] = [];
  if (to.length === 0) return pairs;
  if (from.length === 0) {
    for (const point of to) {
      pairs.push({
        fromX: point.x,
        fromY: point.y + cell * 2,
        fromA: 0,
        fromGlyph: point.glyph,
        toX: point.x,
        toY: point.y,
        toA: point.alpha,
        toGlyph: point.glyph,
        delay: (point.x / w) * MAX_DELAY,
        bend: 0,
      });
    }
    return pairs;
  }

  // -- 起点入桶 --------------------------------------------------------------
  const cols = Math.max(1, Math.ceil(w / cell) + 2);
  const rows = Math.max(1, Math.ceil(h / cell) + 2);
  const buckets: number[][] = new Array(cols * rows);
  const index = (cx: number, cy: number): number =>
    Math.min(rows - 1, Math.max(0, cy)) * cols + Math.min(cols - 1, Math.max(0, cx));
  for (let i = 0; i < from.length; i += 1) {
    const key = index(Math.floor(from[i].x / cell), Math.floor(from[i].y / cell));
    const bucket = buckets[key];
    if (bucket) bucket.push(i);
    else buckets[key] = [i];
  }
  // `used` 同时表示「已被认领」，最后回收没人认领的起点时直接读它。
  const used = new Uint8Array(from.length);
  const maxRing = Math.max(cols, rows);

  /** 从 (cx, cy) 开始一圈圈向外找，命中即返回起点下标。 */
  const claim = (tx: number, ty: number): number => {
    const cx = Math.floor(tx / cell);
    const cy = Math.floor(ty / cell);
    for (let ring = 0; ring <= maxRing; ring += 1) {
      let best = -1;
      let bestDistance = Infinity;
      const xa = cx - ring;
      const xb = cx + ring;
      const ya = cy - ring;
      const yb = cy + ring;
      for (let gx = xa; gx <= xb; gx += 1) {
        for (let gy = ya; gy <= yb; gy += 1) {
          // 只看这一圈的边框格子，里面几圈上一轮已经找过了。
          if (ring > 0 && gx !== xa && gx !== xb && gy !== ya && gy !== yb) continue;
          const bucket = buckets[index(gx, gy)];
          if (!bucket) continue;
          for (const i of bucket) {
            if (used[i]) continue;
            const p = from[i];
            const distance = (p.x - tx) ** 2 + (p.y - ty) ** 2;
            if (distance < bestDistance) {
              bestDistance = distance;
              best = i;
            }
          }
        }
      }
      if (best >= 0) {
        used[best] = 1;
        return best;
      }
    }
    return -1;
  };

  // 按 seed 排序而不是按行序：认领顺序带一点确定性随机，落点才是自然散布的。
  const targets = to.slice().sort((a, b) => a.seed - b.seed);
  for (const point of targets) {
    const found = claim(point.x, point.y);
    const delay = (point.x / w) * MAX_DELAY;
    if (found < 0) {
      pairs.push({
        fromX: point.x,
        fromY: point.y + cell * 2,
        fromA: 0,
        fromGlyph: point.glyph,
        toX: point.x,
        toY: point.y,
        toA: point.alpha,
        toGlyph: point.glyph,
        delay,
        bend: 0,
      });
      continue;
    }
    const start = from[found];
    const distance = Math.hypot(start.x - point.x, start.y - point.y);
    pairs.push({
      fromX: start.x,
      fromY: start.y,
      fromA: start.alpha,
      fromGlyph: start.glyph,
      toX: point.x,
      toY: point.y,
      toA: point.alpha,
      toGlyph: point.glyph,
      delay,
      bend: Math.sin(point.seed) * Math.min(maxBend, distance * bendScale),
    });
  }

  // 没人认领的起点：原地上飘淡出。
  for (let i = 0; i < from.length; i += 1) {
    if (used[i]) continue;
    const start = from[i];
    pairs.push({
      fromX: start.x,
      fromY: start.y,
      fromA: start.alpha,
      fromGlyph: start.glyph,
      toX: start.x,
      toY: start.y - cell * 2,
      toA: 0,
      toGlyph: start.glyph,
      delay: (start.x / w) * MAX_DELAY,
      bend: 0,
    });
  }

  return pairs;
}
