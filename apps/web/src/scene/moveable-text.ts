/**
 * “我是谁？”板块里的正文动画引擎。
 *
 * 每个字都是一个独立对象，所以文字可以整体被打散、聚拢、再弹回原位。四件事
 * 共用同一套积分：
 *
 *   - 打字机：按顺序逐字出现；
 *   - 聚拢：所有字缩成一团叠在一起（比如藏在“你好！”背后）；
 *   - 扩散：从团里弹出去，排到正确的位置；
 *   - 破碎重组：从某个中心炸开，再由弹簧拉回来。
 *
 * 位移由“冲量 + 弹簧 + 硬性夹取”三条一起管：弹簧负责归位，夹取保证任何一个字
 * 都不会离原位超过 `maxOffset`，所以字永远不会飞出画布被裁掉。
 *
 * 每个字的位置直接从真实段落元素量出来（逐字取 range 矩形），画布上的副本因此
 * 和浏览器排出来的版天然一致，换字号、换视口都不必重新实现断行规则。
 */

export interface MoveableTextOptions {
  /** 承载画布的元素，比文字区域大一圈，给散开留余量。 */
  host: HTMLElement;
  /** 已经存在的画布，由板块创建并控制层级。 */
  canvas: HTMLCanvasElement;
  /** 提供字形与字体度量的真实文字元素。 */
  source: HTMLElement;
  /** 正文字色。 */
  color: string;
  /** 离原位允许的最大距离（px）。必须小于 host 的 inset，否则会被裁。 */
  maxOffset: number;
}

export interface MoveableTextHandle {
  /** 逐字淡入（打字机）。stagger 为每个字的间隔，单位秒。 */
  typeIn(stagger?: number): void;
  /** 立刻显示全部文字并归位。 */
  showAll(): void;
  /** 所有字缩成一团，叠加在给定的画布坐标处。 */
  gather(x: number, y: number): void;
  /**
   * 让聚拢的正文一个一个出场：每个字先在团心亮起来，亮完飞回原位，下一个才出现。
   *
   * @param hold 每个字亮了多久才开始飞走（秒）
   */
  clump(hold: number): void;
  /** 从当前的团里扩散出来，排回正确位置。 */
  disperse(): void;
  /** 全部归位并显示。 */
  settle(): void;
  /** 从某个点向外抛出所有字（视口坐标），之后由弹簧拉回。 */
  blast(clientX: number, clientY: number, strength?: number): void;
  /** 从自身中心炸开。 */
  shatter(strength?: number): void;
  /**
   * 顺着手势推字：光标附近（视口坐标）的字会被带着走，离开后弹簧归位。
   * 这就是 moveableText 里“鼠标划过把字蹭开”的手感。
   */
  stir(clientX: number, clientY: number, vx: number, vy: number): void;
  /** 整体淡出。 */
  fadeOut(): void;
  /** 重新量排版，并立刻回到“已归位、全可见”状态。 */
  reset(): void;
  setActive(active: boolean): void;
  /** 已经排好版的字数（跳过空白），用来决定“写入”要写多少个字。 */
  glyphCount(): number;
  dispose(): void;
}

/** 打字机每个字之间的间隔（秒）与单字淡入时间。 */
const TYPE_STAGGER = 0.16;
const TYPE_FADE = 0.24;
/** 扩散 / 写入 / 炸开的基准初速（px/s）。 */
const BLAST_SPEED = 2400;
const DISPERSE_SPEED = 900;
/** 接力出场时，每个字飞回原位的初速（px/s）。 */
const LAUNCH_SPEED = 620;
/** 鼠标划过时的影响半径（px）。 */
const STIR_RADIUS = 95;
/** 鼠标划过时沿手势方向的最强推力（px/s）与向外散开的力度。 */
const STIR_SPEED = 620;
const STIR_SPREAD = 220;
/** 聚拢状态下允许的散开半径（px）：要让整团看起来还是一坨。 */
const HOLD_RADIUS = 26;
/** 弹簧与阻尼：欠阻尼，所以归位时会有一点回弹。 */
const SPRING = 30;
const DAMPING = 5.2;
/** 速度上限，避免极端冲量把字瞬间甩出去。 */
const MAX_SPEED = 5000;
/** 整体淡出的速度（每秒透明度）。 */
const FADE_RATE = 3.4;
/** 判断“已经归位”的容差。 */
const REST_TOLERANCE = 0.3;

interface Glyph {
  char: string;
  /** 原位（归位目标）。 */
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0..1 呈现透明度。 */
  alpha: number;
  /** 该字淡入需要多久（秒）。接力出场用的是一个个字自己的节奏。 */
  fade: number;
  /** 打字机里该字的出场时刻（秒），相对计时起点。 */
  typeAt: number;
  /**
   * 是否已经“脱离团心”：聚拢时所有字都挤在 hold 上；一旦某个字被释放，它就有
   * 自己的目标点（自己的原位）了。
   */
  free: boolean;
  /**
   * 还藏在团心里、没被释放的字。这些字一直贴着团心、跟着团一起淡入，绝不参与
   * 打字机的逐字淡入——否则会在“你好！”背后露出一团叠在一起的字。
   */
  pending: boolean;
}
export function createMoveableText(options: MoveableTextOptions): MoveableTextHandle {
  return new MoveableText(options);
}

class MoveableText {
  private readonly options: MoveableTextOptions;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly glyphs: Glyph[] = [];

  private width = 0;
  private height = 0;
  private dpr = 1;
  private fontSpec = '';
  private fontSize = 16;

  private time = 0;
  private lastTime = 0;
  private textAlpha = 1;
  /** 非 null 时，所有字的弹簧目标改成这个点（聚拢状态）。 */
  private hold: { x: number; y: number } | null = null;
  /** clump() 设的单字停留时长（秒）。 */
  private clumpHold = 0.4;
  /** 下一个要出场的字的下标。 */
  private clumpIndex = 0;
  /** 当前正在团心亮着的那个字的下标；-1 表示此刻没有。 */
  private activeIndex = -1;
  /** 当前这个字该飞走的时刻（引擎时间，秒）。 */
  private activeUntil = 0;
  private clumpPending = false;
  private active = true;
  private running = false;
  private disposed = false;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: MoveableTextOptions) {
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

  typeIn(stagger = TYPE_STAGGER): void {
    if (this.disposed) return;
    this.hold = null;
    this.glyphs.forEach((glyph, index) => {
      glyph.alpha = 0;
      glyph.typeAt = index * stagger;
      glyph.x = glyph.homeX;
      glyph.y = glyph.homeY;
      glyph.vx = 0;
      glyph.vy = 0;
      glyph.free = true;
      glyph.pending = false;
    });
    this.clumpPending = false;
    this.time = 0;
    this.textAlpha = 1;
    this.start();
  }

  showAll(): void {
    if (this.disposed) return;
    this.hold = null;
    for (const glyph of this.glyphs) {
      glyph.alpha = 1;
      glyph.x = glyph.homeX;
      glyph.y = glyph.homeY;
      glyph.vx = 0;
      glyph.vy = 0;
      glyph.free = true;
      glyph.pending = false;
    }
    this.clumpPending = false;
    this.textAlpha = 1;
    this.start();
  }

  gather(x: number, y: number): void {
    if (this.disposed) return;
    // 关键：聚拢不是“瞬移一下就完事”，而是把弹簧的目标点也一起改掉，
    // 否则弹簧会立刻把字拉回原位（那就等于没聚拢）。
    this.hold = { x, y };
    for (const glyph of this.glyphs) {
      glyph.free = false;
      glyph.pending = true;
      glyph.x = x;
      glyph.y = y;
      glyph.vx = 0;
      glyph.vy = 0;
      // 每个字本身是实的（alpha=1），整团的“浮现”由 textAlpha 统一控制；这样
      // 散开时字已经是实心的，不会再淡入一次。
      glyph.alpha = 1;
    }
    this.time = 0;
    this.textAlpha = 1;
    this.clumpPending = false;
    this.clumpIndex = 0;
    this.activeIndex = -1;
    this.start();
  }

  /**
   * 让聚拢的正文一个一个“出场”：每个字先在团心亮起来，亮完立刻飞回自己的位置；
   * 它一开始飞，下一个字才出现。所以任意时刻屏幕上只有一个字是“新出现”的，
   * 不会出现一整团字一起浮出来。
   *
   * @param hold 每个字亮了多久才开始飞走（秒）
   */
  clump(hold: number): void {
    if (this.disposed) return;
    if (!this.hold) {
      // 没聚拢过（比如直接跳进这一阶段）：退化成“直接排好版”。
      this.showAll();
      return;
    }
    this.clumpHold = hold;
    this.clumpPending = true;
    this.clumpIndex = 0;
    this.activeIndex = -1;
    this.activeUntil = 0;
    this.start();
  }

  disperse(): void {
    if (this.disposed) return;
    // 松开聚拢点，同时朝各自的原位给一个初速，整团就像被炸开一样铺回版面。
    this.hold = null;
    for (const glyph of this.glyphs) {
      glyph.free = true;
      glyph.pending = false;
      const dx = glyph.homeX - glyph.x;
      const dy = glyph.homeY - glyph.y;
      const distance = Math.hypot(dx, dy) || 1;
      const speed = DISPERSE_SPEED * (0.6 + Math.min(distance / 400, 1.2));
      glyph.vx = (dx / distance) * speed;
      glyph.vy = (dy / distance) * speed;
    }
    this.start();
  }

  /** 全部归位并显示（收尾用）。 */
  settle(): void {
    if (this.disposed) return;
    this.hold = null;
    this.clumpPending = false;
    for (const glyph of this.glyphs) {
      glyph.free = true;
      glyph.pending = false;
      glyph.alpha = 1;
      glyph.x = glyph.homeX;
      glyph.y = glyph.homeY;
      glyph.vx = 0;
      glyph.vy = 0;
    }
    this.textAlpha = 1;
    this.start();
  }

  /**
   * 让一个字“出场”：它先在团心亮起来（落在 pending 之外、由 alpha 淡入），
   * 闪光结束后由调用方在下一拍把它 launch() 出去。
   */
  private spawn(glyph: Glyph): void {
    glyph.pending = false;
    glyph.free = false;
    // “啪”的一下就出现，不做淡入：屏幕上永远只有一个字是新出现的，淡入反而糊。
    glyph.alpha = 1;
    glyph.fade = 0;
    glyph.typeAt = this.time;
    glyph.x = this.hold ? this.hold.x : glyph.homeX;
    glyph.y = this.hold ? this.hold.y : glyph.homeY;
    glyph.vx = 0;
    glyph.vy = 0;
  }

  /** 把一个已经亮起来的字送走：目标从团心换成自己的原位。 */
  private launch(glyph: Glyph): void {
    glyph.free = true;
    glyph.pending = false;
    glyph.fade = 0;
    glyph.alpha = 1;
    const dx = glyph.homeX - glyph.x;
    const dy = glyph.homeY - glyph.y;
    const distance = Math.hypot(dx, dy) || 1;
    const speed = LAUNCH_SPEED * (0.4 + Math.min(distance / 520, 0.9));
    glyph.vx = (dx / distance) * speed;
    glyph.vy = (dy / distance) * speed;
  }

  blast(clientX: number, clientY: number, strength = 1): void {
    if (this.disposed) return;
    const centre = this.toCanvas(clientX, clientY);
    const reach = Math.hypot(this.width, this.height) || 1;

    for (const glyph of this.glyphs) {
      const dx = glyph.x - centre.x;
      const dy = glyph.y - centre.y;
      const distance = Math.hypot(dx, dy) || 1;
      const bias = 0.45 + (distance / reach) * 1.1;
      glyph.vx += (dx / distance) * BLAST_SPEED * bias * strength;
      glyph.vy += (dy / distance) * BLAST_SPEED * bias * strength;
    }
    this.start();
  }

  shatter(strength = 1): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    this.blast(rect.left + rect.width / 2, rect.top + rect.height / 2, strength);
  }

  stir(clientX: number, clientY: number, vx: number, vy: number): void {
    if (this.disposed) return;
    const centre = this.toCanvas(clientX, clientY);
    // vx / vy 是“两次事件之间的位移”，不是速度。先归一化成方向，再按移动幅度
    // 换算力度，否则轻轻的几像素位移几乎推不动字。
    const speed = Math.hypot(vx, vy);
    if (speed < 0.5) return;
    const dirX = vx / speed;
    const dirY = vy / speed;
    const power = Math.min(1, speed / 26);

    const radius = STIR_RADIUS * (1 + power * 0.7);
    const radiusSq = radius * radius;

    for (const glyph of this.glyphs) {
      const dx = glyph.x - centre.x;
      const dy = glyph.y - centre.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) continue;

      const falloff = 1 - distanceSq / radiusSq;
      const distance = Math.sqrt(distanceSq) || 1;
      // 顺着手势走，再加一点向外的散开，字才会被“蹭”开而不是整体平移。
      glyph.vx += (dirX * STIR_SPEED + (dx / distance) * STIR_SPREAD) * falloff * power;
      glyph.vy += (dirY * STIR_SPEED + (dy / distance) * STIR_SPREAD) * falloff * power;
    }
    this.start();
  }

  /** 视口坐标 → 画布内坐标。 */
  private toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  fadeOut(): void {
    if (this.disposed) return;
    this.textAlpha = 0;
    this.start();
  }

  reset(): void {
    if (this.disposed) return;
    this.layout();
    this.showAll();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.start();
  }

  glyphCount(): number {
    return this.glyphs.length;
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

  /** 按真实文字的排版重建整批字形。 */
  private layout(): void {
    const rect = this.options.host.getBoundingClientRect();
    this.width = Math.max(Math.round(rect.width), 1);
    this.height = Math.max(Math.round(rect.height), 1);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    const element = this.options.source;
    const canvasRect = this.canvas.getBoundingClientRect();
    const metrics = getComputedStyle(element);
    this.fontSize = parseFloat(metrics.fontSize) || this.fontSize;
    this.fontSpec = `${metrics.fontStyle} ${metrics.fontWeight} ${this.fontSize}px ${metrics.fontFamily}`;

    const glyphs: Glyph[] = [];
    const node = element.firstChild;

    if (node && node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const range = document.createRange();

      for (let index = 0; index < text.data.length; index += 1) {
        const char = text.data[index];
        if (char === '\n' || char.trim() === '') continue;

        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const box = range.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;

        const x = box.left - canvasRect.left + box.width / 2;
        const y = box.top - canvasRect.top + box.height / 2;
        glyphs.push({
          char,
          homeX: x,
          homeY: y,
          x,
          y,
          vx: 0,
          vy: 0,
          alpha: 1,
          fade: 0,
          typeAt: glyphs.length * TYPE_STAGGER,
          free: true,
          pending: false,
        });
      }
    }

    this.glyphs.length = 0;
    this.glyphs.push(...glyphs);
  }

  private font(): string {
    return this.fontSpec || `400 ${this.fontSize}px sans-serif`;
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

    const settled = this.integrate(dt);
    this.render();

    if (settled) {
      this.running = false;
      return;
    }
    this.raf = window.requestAnimationFrame(this.frame);
  };

  /** 返回 true 表示全部归位且静止，循环可以睡下。 */
  private integrate(dt: number): boolean {
    const decay = Math.exp(-DAMPING * dt);
    let settled = true;

    if (this.textAlpha > 0 && this.textAlpha < 1) {
      this.textAlpha = Math.max(0, this.textAlpha - FADE_RATE * dt);
      if (this.textAlpha > 0) settled = false;
    }

    // 一字一换的接力：当前这个字先在团心亮起来，亮满 clumpHold 立刻飞回原位；
    // 它一走，下一个字才开始出现。任一时刻只有一个“新出现”的字。
    if (this.clumpPending) {
      const active = this.activeIndex >= 0 ? this.glyphs[this.activeIndex] : null;
      if (active && this.time >= this.activeUntil) {
        this.launch(active);
        this.activeIndex = -1;
      }
      if (this.activeIndex < 0 && this.clumpIndex < this.glyphs.length) {
        const next = this.glyphs[this.clumpIndex];
        this.spawn(next);
        this.activeIndex = this.clumpIndex;
        this.clumpIndex += 1;
        this.activeUntil = this.time + this.clumpHold;
      }
      if (this.clumpIndex >= this.glyphs.length && this.activeIndex < 0) this.clumpPending = false;
      else settled = false;
    }

    for (const glyph of this.glyphs) {
      // 打字机 / 接力出场：到点就淡入。藏起来的字不参与，见 pending。
      if (!glyph.pending && glyph.alpha < 1) {
        const fade = glyph.fade || TYPE_FADE;
        glyph.alpha = Math.max(0, Math.min(1, (this.time - glyph.typeAt) / fade));
        if (glyph.alpha < 1) settled = false;
      }

      // 聚拢时弹簧的目标是团心（除非这个字已经被“写入”、脱离出去了），
      // 否则才是自己的原位。
      const targetX = this.hold && !glyph.free ? this.hold.x : glyph.homeX;
      const targetY = this.hold && !glyph.free ? this.hold.y : glyph.homeY;
      glyph.vx += (targetX - glyph.x) * dt * SPRING;
      glyph.vy += (targetY - glyph.y) * dt * SPRING;
      glyph.vx *= decay;
      glyph.vy *= decay;

      const speed = Math.hypot(glyph.vx, glyph.vy);
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        glyph.vx *= scale;
        glyph.vy *= scale;
      }

      glyph.x += glyph.vx * dt;
      glyph.y += glyph.vy * dt;

      // 关键的一道：离目标太远就拉回来，字永远不会飞出画布被裁掉。聚拢状态下
      // 夹取要放宽，否则团会散开成一个大圆。
      const offX = glyph.x - targetX;
      const offY = glyph.y - targetY;
      const offset = Math.hypot(offX, offY);
      const limit = this.hold && !glyph.free ? HOLD_RADIUS : this.options.maxOffset;
      if (offset > limit) {
        const scale = limit / offset;
        glyph.x = targetX + offX * scale;
        glyph.y = targetY + offY * scale;
        const nx = offX / offset;
        const ny = offY / offset;
        const outward = glyph.vx * nx + glyph.vy * ny;
        if (outward > 0) {
          glyph.vx -= outward * nx;
          glyph.vy -= outward * ny;
        }
      }

      const near =
        Math.abs(glyph.x - targetX) < REST_TOLERANCE &&
        Math.abs(glyph.y - targetY) < REST_TOLERANCE &&
        Math.abs(glyph.vx) < 2 &&
        Math.abs(glyph.vy) < 2;
      if (!near) settled = false;
      else {
        glyph.x = targetX;
        glyph.y = targetY;
        glyph.vx = 0;
        glyph.vy = 0;
      }
    }

    return settled;
  }

  // -- 渲染 -----------------------------------------------------------------

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    if (this.textAlpha <= 0.001) return;

    context.font = this.font();
    context.fillStyle = this.options.color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (const glyph of this.glyphs) {
      // pending 的字还藏在团心里，一个都不能画。以前这里漏了这个判断，结果 300 多
      // 个字全叠在团心一起画出来，变成一坨深色块，接力出场反而看不见了。
      if (glyph.pending || glyph.alpha <= 0.01) continue;
      context.globalAlpha = glyph.alpha * this.textAlpha;
      context.fillText(glyph.char, glyph.x, glyph.y);
    }

    context.globalAlpha = 1;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
  }
}
