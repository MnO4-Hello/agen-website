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
 *   3. 溶解：整张马赛克一边胀大（相邻方块叠成一团）一边淡出；
 *   4. 换图：照片同时从 1.06 缩回 1.0 淡入，露出来的是清晰、带圆角的照片。
 *
 * **这里刻意不用 `context.filter = blur(...)`。** 早期版本在第 3 步给整张马赛克加
 * 34px 高斯模糊，看起来确实「糊得恰到好处」，代价却是每帧对**一整张铺满视口的
 * fixed 画布**（DPR 2 时可达一千多万像素）做一次卷积——普通笔记本直接掉到个位数帧率。
 * 现在的溶解只用 `fillRect` 的尺寸与 `globalAlpha`，外加一次 `drawImage`。
 *
 * 关键点：第 4 步必须与第 3 步在时间上重叠（马赛克还没散完照片就开始进），否则会
 * 露一帧空相框；而相框本身**不做任何裁切或淡入**（早期版本用 clip-path，结果既像
 * 蒙版又把粒子盖住了）。
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
  /** 设置整体进度：0 未开始，1 马赛克已散尽、照片完全接管。 */
  setProgress(value: number): void;
  /** 相框位置/尺寸变了之后按新矩形重绘。 */
  sync(): void;
  /**
   * 图层是否还在用。
   *
   * 入场结束后画布被 `opacity: 0` 盖掉，但 `scroll` / `resize` 仍会把它整屏重绘一遍
   * （一千多万像素的清屏 + 几百个 fillRect）。关掉之后这些空转全部省下。
   */
  setEnabled(active: boolean): void;
  dispose(): void;
}

/** 各阶段在进度轴上的位置。 */
const T_CONVERGE = 0.36;
const T_MORPH_AT = 0.38;
const T_MORPH_END = 0.5;
/** 马赛克开始胀大淡出。 */
const T_DISSOLVE_AT = 0.56;
const T_DISSOLVE_END = 0.8;
/** 照片淡入（比溶解稍晚一点起步，两段重叠着完成交接）。 */
const T_SWAP_AT = 0.58;
const T_SWAP_END = 0.8;
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
  private enabled = true;
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

  setEnabled(active: boolean): void {
    if (this.disposed || this.enabled === active) return;
    this.enabled = active;
    // 重新启用时立刻补一帧：期间尺寸/位置可能已经变过（`sync()` 被跳过了绘制）。
    if (active) this.render();
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
    // DPR 上限刻意压到 1.5（别抬高）：这一层只是入场的过渡装置，settle 之后照片由
    // 真实 `<img>` 接管清晰度，而整屏画布的像素量对帧率是平方级的影响。
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
    if (!this.enabled) return;
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    if (this.points.length === 0 || this.unit <= 0) return;
    const p = this.progress;
    if (p <= 0) return;

    // 3、4 两段在时间上重叠：马赛克一边胀大淡出，照片一边从 1.06 缩回 1.0 淡入。
    // 重叠着换图，交接处不会露一帧空相框；全程只有 fillRect 与一次 drawImage。
    const dissolve = smoothstep(
      clamp01((p - T_DISSOLVE_AT) / (T_DISSOLVE_END - T_DISSOLVE_AT)),
    );
    if (dissolve < 1) this.drawMosaic(context, p, dissolve);

    const enter = smoothstep(clamp01((p - T_SWAP_AT) / (T_SWAP_END - T_SWAP_AT)));
    if (enter > 0 && this.image.naturalWidth > 0) {
      const size = this.unit * PORTRAIT_DESIGN;
      const box = size * (1.06 - 0.06 * enter);
      context.globalAlpha = enter;
      context.save();
      roundedRect(context, this.frameX, this.frameY, size, size, PHOTO_RADIUS);
      context.clip();
      context.drawImage(
        this.image,
        this.frameX + (size - box) / 2,
        this.frameY + (size - box) / 2,
        box,
        box,
      );
      context.restore();
      context.globalAlpha = 1;
    }
  }

  /**
   * 圆点汇聚 → 长成方格 → 胀大淡出。
   *
   * @param dissolve 0 = 完好的一张马赛克；1 = 完全散尽（此时调用方已不再调它）。
   */
  private drawMosaic(context: CanvasRenderingContext2D, p: number, dissolve: number): void {
    const converge = smoothstep(clamp01(p / T_CONVERGE));
    const morph = smoothstep(clamp01((p - T_MORPH_AT) / (T_MORPH_END - T_MORPH_AT)));
    // 胀大到 1.9 倍时相邻方块互相叠合，整片看起来像一块正在化开的东西；
    // 同时整层降 alpha，比高斯模糊便宜四个数量级。
    const grow = 1 + dissolve * 0.9;

    const cell = this.gap * this.unit;
    const dot = Math.max(MIN_SIZE, cell * DOT_RATIO);
    const block = Math.max(MIN_SIZE, cell * BLOCK_RATIO);
    const size = (dot + (block - dot) * morph) * grow;
    const corner = (size * 0.5) * (1 - morph) + size * 0.06 * morph;

    context.globalAlpha = 1 - dissolve;
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
    context.globalAlpha = 1;
  }
}
