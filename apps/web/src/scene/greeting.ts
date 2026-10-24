/**
 * 正文区域正中的“你好！”——整段开场的引信。
 *
 * 它和正文共用一块舞台（画布坐标系一致），位置取正文段落的中心，字号明显更大，
 * 所以一出现就抢眼。生命周期是一条单向的时间线：
 *
 *   1. typeIn()   大字逐字打出来，末尾跟一条闪烁的光标；
 *   2. scatter()  文字像被弹开一样散落淡出；
 *   3. reset()    回到“一个字都没有”的状态（光标也收起）。
 *
 * 光标就在打字时跟着刚敲出来的那个字往后退，整行打完之后它淡出——和标题
 * “我是谁？”的行为完全一致，不做任何变形或停留。正文本身“叠成一团再逐个
 * 排开”的动画由 ../scene/moveable-text.ts 负责，这里不参与。
 *
 * 注意：光标只有在 typeIn() 之后才存在。在此之前它既不显示也不闪烁，否则页面
 * 一进入就能看到一根光标空闪。
 */

export interface GreetingOptions {
  /** 承载画布的元素（和正文画布同尺寸）。 */
  host: HTMLElement;
  /** 已经存在的画布，由板块创建，层级更好控制。 */
  canvas: HTMLCanvasElement;
  /** 正文元素：用它来定位中心、按比例定字号。 */
  source: HTMLElement;
  text: string;
  color: string;
  /** 光标颜色。 */
  caretColor: string;
  /** 散落初期字块的高亮色。 */
  flare: string;
  /** 字号 = 正文字号 × 这个倍数，让“你好！”足够醒目。 */
  fontScale: number;
  /** 打字机每个字的间隔（秒）。 */
  stagger: number;
}

export interface GreetingHandle {
  /** 回到“一个字都没有”的初始状态（光标也收起）。 */
  reset(): void;
  /** 大字逐字打出；光标跟着字后退，打完后立刻消失。 */
  typeIn(): void;
  /** 文字散落淡出消失。 */
  scatter(): void;
  setActive(active: boolean): void;
  dispose(): void;
}

/** 单字淡入时间（秒）。 */
const TYPE_FADE = 0.16;
/** 散落：初速、上抛、重力与淡出速度。 */
const SCATTER_SPEED = 560;
const SCATTER_RISE = 150;
const SCATTER_GRAVITY = 780;
const SCATTER_FADE = 2.6;
/**
 * 光标尺寸（相对字号）——和标题“我是谁？”的 CSS（width: .075em / height: .86em）完全
 * 一致，这样两个光标看起来是同一个东西。
 */
const CARET_WIDTH = 0.075;
const CARET_HEIGHT = 0.86;
/** 光标与字符之间留的空隙（em）。很小，只是别黏在字上。 */
const CARET_GAP = 0.04;

interface Chunk {
  char: string;
  /** 原位。 */
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  alpha: number;
  /** 打字机里该字的出场时刻（秒）。 */
  typeAt: number;
  /** 散落方向（单位向量）。 */
  dirX: number;
  dirY: number;
  /** <0 表示还没散落；>=0 表示散落已经过去的时间。 */
  scatterAge: number;
}

export function createGreeting(options: GreetingOptions): GreetingHandle {
  return new Greeting(options);
}

class Greeting {
  private readonly options: GreetingOptions;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly chunks: Chunk[] = [];

  private width = 0;
  private height = 0;
  private dpr = 1;
  private fontSize = 16;
  private fontSpec = '';
  /** 各字块的横向推进量，用来算光标该停在哪。 */
  private advances: number[] = [];
  /** 整行左端在画布里的 x。 */
  private lineStart = 0;
  /** 行基线中心。 */
  private lineY = 0;
  /** 已打出的字数；光标就停在第这个字后面。 */
  private typedCount = 0;

  private time = 0;
  private lastTime = 0;
  /** 是否已经进入打字阶段；在 typeIn() 之前一个字都不该出现（光标也是）。 */
  private typing = false;
  /** 打字是否已经收工（最后一个字淡入完毕）。收工后光标立刻消失。 */
  private typedDone = false;

  private active = true;
  private running = false;
  private disposed = false;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: GreetingOptions) {
    this.options = options;
    this.canvas = options.canvas;

    const context = options.canvas.getContext('2d');
    if (!context) {
      throw new Error('2D canvas context is unavailable');
    }
    this.context = context;

    this.layout();
    this.watchSize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.dispose);
  }

  // -- 对外接口 -------------------------------------------------------------

  reset(): void {
    if (this.disposed) return;
    this.layout();
    this.time = 0;
    this.typing = false;
    this.typedDone = false;
    this.typedCount = 0;
    for (const chunk of this.chunks) {
      chunk.alpha = 0;
      chunk.x = chunk.homeX;
      chunk.y = chunk.homeY;
      chunk.vx = 0;
      chunk.vy = 0;
      chunk.rotation = 0;
      chunk.spin = 0;
      chunk.scatterAge = -1;
    }
    this.render();
  }

  typeIn(): void {
    if (this.disposed) return;
    this.layout();
    this.time = 0;
    this.typing = true;
    this.typedDone = false;
    this.typedCount = 0;
    this.chunks.forEach((chunk, index) => {
      chunk.alpha = 0;
      chunk.x = chunk.homeX;
      chunk.y = chunk.homeY;
      chunk.vx = 0;
      chunk.vy = 0;
      chunk.rotation = 0;
      chunk.spin = 0;
      chunk.scatterAge = -1;
      chunk.typeAt = index * this.options.stagger;
    });
    this.start();
  }

  scatter(): void {
    if (this.disposed) return;
    for (const chunk of this.chunks) {
      chunk.scatterAge = 0;
      const speed = SCATTER_SPEED * (0.7 + Math.random() * 0.8);
      // 向两侧飞散并略微上抛，看起来像被弹开。
      chunk.vx = chunk.dirX * speed;
      chunk.vy = chunk.dirY * speed - SCATTER_RISE;
      chunk.spin = (Math.random() - 0.5) * 9;
      chunk.alpha = 1;
    }
    this.start();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.start();
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    window.cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pagehide', this.dispose);
  };

  // -- 排版 -----------------------------------------------------------------

  private watchSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      this.layout();
      this.render();
    });
    this.resizeObserver.observe(this.options.host);
  }

  private onResize = (): void => {
    this.layout();
    this.render();
  };

  /** 按正文的中心和放大的字号把“你好！”排成一行居中。 */
  private layout(): void {
    const hostRect = this.options.host.getBoundingClientRect();
    this.width = Math.max(Math.round(hostRect.width), 1);
    this.height = Math.max(Math.round(hostRect.height), 1);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    const source = this.options.source;
    const sourceRect = source.getBoundingClientRect();
    const metrics = getComputedStyle(source);
    const sourceSize = parseFloat(metrics.fontSize) || 16;

    const chars = [...this.options.text];
    const wanted = sourceSize * this.options.fontScale;
    const fitsWidth = (this.width * 0.6) / Math.max(1, chars.length * 1.1);
    this.fontSize = Math.max(12, Math.min(wanted, fitsWidth, this.height * 0.5));
    this.fontSpec = `700 ${this.fontSize}px ${metrics.fontFamily}`;

    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.font = this.fontSpec;

    this.advances = chars.map((char) => context.measureText(char).width);
    const total = this.advances.reduce((sum, value) => sum + value, 0);

    const canvasRect = this.canvas.getBoundingClientRect();
    const centreX = sourceRect.left - canvasRect.left + sourceRect.width / 2;
    const centreY = sourceRect.top - canvasRect.top + sourceRect.height / 2;
    this.lineStart = centreX - total / 2;
    this.lineY = centreY;

    let cursor = this.lineStart;
    this.chunks.length = 0;
    chars.forEach((char, index) => {
      const x = cursor + this.advances[index] / 2;
      cursor += this.advances[index];
      const dx = x - centreX;
      const distance = Math.abs(dx) || 1;
      this.chunks.push({
        char,
        homeX: x,
        homeY: centreY,
        x,
        y: centreY,
        vx: 0,
        vy: 0,
        rotation: 0,
        spin: 0,
        alpha: 0,
        typeAt: index * this.options.stagger,
        dirX: dx / distance,
        dirY: 0,
        scatterAge: -1,
      });
    });
  }

  /**
   * 光标的位置与大小（画布坐标）。横向对齐用 `measureText` 的真实字体度量：
   * `actualBoundingBoxRight` 是刚敲出来的那个字墨迹的右边缘。尺寸固定按字号算，
   * 和标题的光标（CSS 的 em 值）保持一致，所以光标永远是同一根竖线。
   */
  private caretBox(): { x: number; y: number; w: number; h: number } {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.font = this.fontSpec;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    const width = Math.max(1, this.fontSize * CARET_WIDTH);
    const height = this.fontSize * CARET_HEIGHT;
    const gap = this.fontSize * CARET_GAP;

    const index = Math.min(this.typedCount, this.chunks.length) - 1;
    if (index < 0) {
      // 一个字都还没打出来：整条光标贴在整行左端的外侧。
      return { x: this.lineStart - gap - width, y: this.lineY - height / 2, w: width, h: height };
    }

    const chunk = this.chunks[index];
    const metrics = context.measureText(chunk.char);
    // 紧贴这个字墨迹的右边缘；拿不到度量时用半个字宽兜底。
    const inkRight = chunk.homeX + (metrics.actualBoundingBoxRight || metrics.width / 2);
    return { x: inkRight + gap, y: this.lineY - height / 2, w: width, h: height };
  }

  // -- 循环 -----------------------------------------------------------------

  private start(): void {
    if (this.running || this.disposed || !this.active) return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = window.requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (this.disposed || !this.active) {
      this.running = false;
      return;
    }

    const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0.0001), 0.033);
    this.lastTime = now;
    this.time += dt;

    const typeWindow = this.chunks.length * this.options.stagger + TYPE_FADE;
    let settled = true;

    this.chunks.forEach((chunk, index) => {
      if (chunk.scatterAge >= 0) {
        chunk.scatterAge += dt;
        chunk.vy += SCATTER_GRAVITY * dt;
        chunk.x += chunk.vx * dt;
        chunk.y += chunk.vy * dt;
        chunk.rotation += chunk.spin * dt;
        chunk.alpha = Math.max(0, chunk.alpha - SCATTER_FADE * dt);
        if (chunk.alpha > 0.001) settled = false;
        return;
      }
      if (!this.typing) return;
      const target = Math.max(0, Math.min(1, (this.time - chunk.typeAt) / TYPE_FADE));
      chunk.alpha = target;
      // 字一露头就算“打出来了”，光标随之右移；这个计数只增不减。
      if (target > 0 && index + 1 > this.typedCount) this.typedCount = index + 1;
      if (target < 1) settled = false;
    });

    if (this.typing) {
      // 还在吐字就一直重绘；最后一个字淡入完毕就算收工，光标随之消失。
      if (this.time < typeWindow) settled = false;
      else this.typedDone = true;
    }

    // 循环停下时不做任何清除：打字刚结束时“你好！”还得留在屏幕上等散落，
    // 清掉会把它一起抹掉。光标由 typedDone 自己收掉，不用清画布。
    this.render();
    if (settled) {
      this.running = false;
      return;
    }
    this.raf = window.requestAnimationFrame(this.frame);
  };

  // -- 渲染 -----------------------------------------------------------------

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    context.font = this.fontSpec;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (const chunk of this.chunks) {
      if (chunk.alpha <= 0.01) continue;
      context.save();
      context.globalAlpha = chunk.alpha;
      context.translate(chunk.x, chunk.y);
      context.rotate(chunk.rotation);
      context.fillStyle =
        chunk.scatterAge >= 0 && chunk.alpha > 0.75 ? this.options.flare : this.options.color;
      context.fillText(chunk.char, 0, 0);
      context.restore();
    }

    // 光标：和标题“我是谁？”一样——打字期间紧跟在刚敲出来的字后面往右走，整行
    // 打完之后立刻消失（不留在原地闪）。
    if (this.typing && !this.typedDone) {
      const box = this.caretBox();
      context.fillStyle = this.options.caretColor;
      context.fillRect(box.x, box.y, box.w, box.h);
    }

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
  }
}
