/**
 * 头像的揭示动画。
 *
 * 画布是一层 `position: fixed`、铺满视口的图层，所以小点能从屏幕之外飞进来而不被
 * 相框裁掉。**所有坐标都用视口坐标**（`getBoundingClientRect` 的坐标系），画布也
 * 从视口原点铺开，两者一致，因此无论页面滚到哪里，像素和照片都严丝合缝。
 *
 * 进度由外部驱动，分四段：
 *
 *   1. 汇聚：小圆点从屏幕外飞向各自格心。格子是规则的，落位后就是一行一列排好的；
 *   2. 变形：圆点逐个拉伸成方格，拼出一张马赛克；
 *   3. 模糊：给整张马赛克加一层**很强的**高斯模糊，把细节全部糊掉——糊到从上面
 *      换掉内容也看不出来；
 *   4. 换图：在模糊最厚的这一拍里，把下面的照片换成真实图片（一瞬间完成），随后
 *      模糊迅速褪掉，露出清晰、带圆角的照片。
 *
 * 关键点：第 4 步的“换图”必须发生在模糊最厚的时候，并且相框本身**不做任何裁切
 * 或淡入**（早期版本用 clip-path，结果既像蒙版又把粒子盖住了）。
 */

import { PORTRAIT_DESIGN, type PortraitPoint } from './portrait-points';

export interface PortraitPixelOptions {
  /** 画布元素，必须是铺满视口的 fixed 图层。 */
  canvas: HTMLCanvasElement;
  /** 相框元素；点位和尺寸每帧按它的实际矩形换算。 */
  frame: HTMLElement;
  /** 设计坐标下的点阵。 */
  points: readonly PortraitPoint[];
  /** 网格间距（设计坐标 px），即方块的边长。 */
  gap: number;
  /** 照片本身，用来画“马赛克”的颜色与最终清晰画面。 */
  image: HTMLImageElement;
}

export interface PortraitPixelHandle {
  /** 设置整体进度：0 未开始，1 马赛克 + 模糊都已退场。 */
  setProgress(value: number): void;
  /** 相框位置/尺寸变了之后按新矩形重绘。 */
  sync(): void;
  dispose(): void;
}

/** 各阶段在进度轴上的位置。模糊要涨得快——涨得慢就看不出“糊”这个动作。 */
const T_CONVERGE = 0.36;
const T_MORPH_AT = 0.38;
const T_MORPH_END = 0.5;
/** 模糊从 0 冲到最强。 */
const T_BLUR_AT = 0.52;
const T_BLUR_PEAK = 0.64;
/** 在模糊峰值把内容换成照片，随后迅速褪掉模糊。 */
const T_SWAP = 0.64;
const T_CLEAR_AT = 0.7;
const T_CLEAR_END = 0.87;
/** 最强高斯模糊半径（画布像素）。要大到看不出马赛克与照片的差别。 */
const MAX_BLUR = 34;
/** 最终照片的圆角半径（px）。要和 CSS 里相框的圆角对上。 */
const PHOTO_RADIUS = 18;
/** 汇聚阶段圆点的直径，取格子边长的比例。 */
const DOT_RATIO = 0.46;
/** 方块占格子的比例，留一点缝让网格看得出来。 */
const BLOCK_RATIO = 0.88;
/** 方块最小绘制尺寸。 */
const MIN_SIZE = 0.6;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const smoothstep = (t: number): number => t * t * (3 - 2 * t);
/** 由坐标导出的确定性伪随机数：同一块每帧行为一致。 */
const hash = (x: number, y: number, salt: number): number => {
  const value = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
};

/** 圆角矩形路径；圆角从“半个边长”（正圆）收敛到接近直角。 */
function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, y + height - r);
  context.arcTo(x + width, y + height, x + width - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, y + height - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}

export function createPortraitPixel(options: PortraitPixelOptions): PortraitPixelHandle {
  return new PortraitPixel(options);
}

class PortraitPixel {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly frame: HTMLElement;
  private readonly points: readonly PortraitPoint[];
  private readonly image: HTMLImageElement;
  private readonly gap: number;

  private width = 0;
  private height = 0;
  private dpr = 1;
  /** 相框在视口里的矩形（视口坐标）。 */
  private frameX = 0;
  private frameY = 0;
  private unit = 1;
  private progress = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: PortraitPixelOptions) {
    this.canvas = options.canvas;
    this.frame = options.frame;
    this.points = options.points;
    this.image = options.image;
    this.gap = options.gap;

    const context = options.canvas.getContext('2d');
    if (!context) {
      throw new Error('2D canvas context is unavailable');
    }
    this.context = context;

    this.sync();
    this.watchSize();
    window.addEventListener('resize', this.onSync);
    window.addEventListener('scroll', this.onSync, { passive: true });
    window.addEventListener('pagehide', this.dispose);
  }

  // -- 对外接口 -------------------------------------------------------------

  setProgress(value: number): void {
    if (this.disposed) return;
    const next = clamp01(value);
    if (next === this.progress) return;
    this.progress = next;
    this.render();
  }

  sync(): void {
    if (this.disposed) return;
    this.applySize();
    this.readFrame();
    this.render();
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onSync);
    window.removeEventListener('scroll', this.onSync);
    window.removeEventListener('pagehide', this.dispose);
  };

  // -- 尺寸与定位 -----------------------------------------------------------

  private watchSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.onSync());
    this.resizeObserver.observe(this.frame);
  }

  private onSync = (): void => this.sync();

  private applySize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    // 画布从视口原点铺开，所以画布内坐标 === 视口坐标。
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  private readFrame(): void {
    const rect = this.frame.getBoundingClientRect();
    this.frameX = rect.left;
    this.frameY = rect.top;
    this.unit = rect.width / PORTRAIT_DESIGN;
  }

  // -- 渲染 -----------------------------------------------------------------

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    if (this.points.length === 0 || this.unit <= 0) return;
    const p = this.progress;
    if (p <= 0) return;

    // 模糊最厚时把内容从“马赛克”换成“照片”：两者都在同一层模糊之下，所以换的
    // 那一瞬间看不出来；随后模糊褪掉，露出来的就是清晰照片（不是清晰的马赛克）。
    const swap = clamp01((p - T_SWAP) / 0.04);
    const blur = this.blurAmount(p);
    context.filter = blur > 0.4 ? `blur(${blur.toFixed(2)}px)` : 'none';

    if (swap < 1) this.drawMosaic(context, p);

    if (swap > 0 && this.image.naturalWidth > 0) {
      const size = this.unit * PORTRAIT_DESIGN;
      context.globalAlpha = swap;
      context.save();
      roundedRect(context, this.frameX, this.frameY, size, size, PHOTO_RADIUS);
      context.clip();
      context.drawImage(this.image, this.frameX, this.frameY, size, size);
      context.restore();
      context.globalAlpha = 1;
    }

    context.filter = 'none';
  }

  /** 0 → MAX_BLUR → 0 的高斯模糊量。 */
  private blurAmount(p: number): number {
    if (p <= T_BLUR_AT) return 0;
    if (p <= T_BLUR_PEAK) {
      return MAX_BLUR * smoothstep(clamp01((p - T_BLUR_AT) / (T_BLUR_PEAK - T_BLUR_AT)));
    }
    if (p <= T_CLEAR_AT) return MAX_BLUR;
    return MAX_BLUR * (1 - smoothstep(clamp01((p - T_CLEAR_AT) / (T_CLEAR_END - T_CLEAR_AT))));
  }

  /** 圆点汇聚 → 长成方格；这段是下面被模糊罩住的那张“马赛克”。 */
  private drawMosaic(context: CanvasRenderingContext2D, p: number): void {
    const converge = smoothstep(clamp01(p / T_CONVERGE));
    const morph = smoothstep(clamp01((p - T_MORPH_AT) / (T_MORPH_END - T_MORPH_AT)));

    const cell = this.gap * this.unit;
    const dot = Math.max(MIN_SIZE, cell * DOT_RATIO);
    const block = Math.max(MIN_SIZE, cell * BLOCK_RATIO);
    const size = dot + (block - dot) * morph;
    const corner = (size * 0.5) * (1 - morph) + size * 0.06 * morph;

    context.fillStyle = '#eaf3e6';
    for (const point of this.points) {
      const centreX = this.frameX + point.x * this.unit;
      const centreY = this.frameY + point.y * this.unit;

      // 起点半径必须超过视口对角线，才是真正“从屏幕外”飞进来。
      const angle = hash(point.x, point.y, 1) * Math.PI * 2;
      const radius = Math.max(this.width, this.height) * (0.78 + hash(point.x, point.y, 2) * 0.5);
      const startX = this.width * 0.5 + Math.cos(angle) * radius;
      const startY = this.height * 0.5 + Math.sin(angle) * radius;

      const x = startX + (centreX - startX) * converge;
      const y = startY + (centreY - startY) * converge;

      context.fillStyle = `rgb(${point.r},${point.g},${point.b})`;
      if (morph < 1) {
        roundedRect(context, x - size * 0.5, y - size * 0.5, size, size, corner);
        context.fill();
      } else {
        context.fillRect(x - size * 0.5, y - size * 0.5, size, size);
      }
    }
  }
}
