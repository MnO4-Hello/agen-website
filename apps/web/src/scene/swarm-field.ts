/**
 * 右侧线框里的“粒子团”：一把绿色粒子先自由游走，随后汇聚成一张扑克牌大小的
 * 团块，团块会像洗牌一样在自身附近缓慢漂移，鼠标靠近时会被推开再吸回。
 *
 * 底座是整站那层浅绿，所以粒子同样用饱和度偏高、中心偏亮的绿（色相 168，比
 * 背景光球更冷一点，形成区分），边缘把 alpha 收到 0，落成一颗颗小颗粒。
 *
 * 设计上是 orb-field 的对照：那边是稀疏、缓慢、被吸引；这边是密集、活泼、
 * 被排斥。两处用同一套径向渐变画球，风格统一。
 *
 * 目标位置由一张“牌面网格”给出——按设计坐标（牌宽 × 牌高）铺成行 / 列，
 * 汇聚完成后粒子正好占满一块与卡牌同尺寸的矩形，肉眼看起来就是一张牌。
 */

export interface SwarmFieldOptions {
  /** 画布挂载的元素（尺寸即粒子活动范围）。 */
  host: HTMLElement;
  /** 目标矩形的宽高比（宽 / 高），默认接近扑克牌 0.69。 */
  cardAspect?: number;
  /** 目标矩形边长占宿主短边的比例。 */
  cardFill?: number;
  /** 粒子色相，默认 168（比背景光球更冷的绿，形成区分）。 */
  hue?: number;
  /** 配色：`'brand'` 用上面的色相（默认）｜`'white'` 画成白色。 */
  tone?: 'brand' | 'white';
}

export interface SwarmFieldHandle {
  /** 外部转发指针位置（屏幕坐标）；`inside` 为 false 时不做排斥。 */
  setPointer(clientX: number, clientY: number, inside: boolean): void;
  dispose(): void;
}

const AREA_PER_PARTICLE = 900;
const MIN_PARTICLES = 60;
const MAX_PARTICLES = 190;
/** 自由游走阶段的漂移速度（px/s）。 */
const DRIFT_SPEED = 16;
/** 汇聚弹簧系数（越大越快归位）。 */
const SPRING = 5.2;
/** 汇聚阻尼。 */
const SPRING_DAMP = 3.4;
/** 鼠标排斥半径（px）。 */
const REPEL_RADIUS = 92;
/** 排斥强度（px/s²）。 */
const REPEL_FORCE = 3200;
/** 团块自身的缓慢漂移幅度（px）。 */
const CLUMP_DRIFT = 7;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 目标位置的“偏移半径”，围绕团块中心。 */
  ox: number;
  oy: number;
  radius: number;
  depth: number;
  baseAlpha: number;
  phase: number;
  phaseSpeed: number;
}

export function createSwarmField(options: SwarmFieldOptions): SwarmFieldHandle {
  if (typeof window === 'undefined') {
    return { setPointer: () => {}, dispose: () => {} };
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { setPointer: () => {}, dispose: () => {} };
  }
  const field = new SwarmField(options);
  field.start();
  return {
    setPointer: (x, y, inside) => field.setPointer(x, y, inside),
    dispose: () => field.destroy(),
  };
}

class SwarmField {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly host: HTMLElement;
  private readonly hue: number;
  private readonly tone: 'brand' | 'white';
  private readonly cardAspect: number;
  private readonly cardFill: number;
  private readonly particles: Particle[] = [];
  private readonly pointer = { x: -1e4, y: -1e4, inside: false };

  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private target = MIN_PARTICLES;
  private disposed = false;
  /** 目标矩形的半宽 / 半高（px）。 */
  private halfW = 60;
  private halfH = 87;

  constructor(options: SwarmFieldOptions) {
    this.host = options.host;
    this.hue = options.hue ?? 168;
    this.tone = options.tone ?? 'brand';
    this.cardAspect = options.cardAspect ?? 0.69;
    this.cardFill = options.cardFill ?? 0.42;

    const canvas = document.createElement('canvas');
    canvas.className = 'swarm-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas context is unavailable');

    this.canvas = canvas;
    this.context = context;
    this.host.append(canvas);
    this.resize();
  }

  start(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pagehide', this.destroy);
    this.lastTime = performance.now();
    this.raf = window.requestAnimationFrame(this.frame);
  }

  destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pagehide', this.destroy);
    this.canvas.remove();
  };

  /** 宿主上的 pointermove 交给外部转发，方便线框与粒子共用一次监听。 */
  setPointer(clientX: number, clientY: number, inside: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = clientX - rect.left;
    this.pointer.y = clientY - rect.top;
    this.pointer.inside = inside;
  }

  private onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    // 目标牌面：按短边 × cardFill 定高，再按牌面宽高比推宽。
    const shortEdge = Math.min(this.width, this.height);
    const cardH = shortEdge * this.cardFill;
    const cardW = cardH * this.cardAspect;
    this.halfW = cardW / 2;
    this.halfH = cardH / 2;

    this.target = Math.round(
      clamp((this.width * this.height) / AREA_PER_PARTICLE, MIN_PARTICLES, MAX_PARTICLES),
    );
    this.syncPopulation();
  }

  private syncPopulation(): void {
    while (this.particles.length < this.target) this.spawn();
    if (this.particles.length > this.target) this.particles.length = this.target;
  }

  private spawn(): void {
    const depth = Math.random();
    const particle: Particle = {
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      vx: (Math.random() - 0.5) * DRIFT_SPEED * 2,
      vy: (Math.random() - 0.5) * DRIFT_SPEED * 2,
      ox: 0,
      oy: 0,
      radius: (1.1 + depth * 2.6) * (0.8 + Math.random() * 0.5),
      depth,
      baseAlpha: clamp(0.36 + depth * 0.5, 0.3, 0.9),
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: 0.6 + Math.random() * 1.6,
    };
    this.layoutTarget(particle);
    this.particles.push(particle);
  }

  /** 给一颗粒子分配它在牌面里的位置（在目标矩形内均匀散布）。 */
  private layoutTarget(particle: Particle): void {
    // 在矩形内取一个均匀点，再稍微抖一下，避免出现整齐的网格痕迹。
    particle.ox =
      (Math.random() * 2 - 1) * this.halfW * (0.55 + Math.random() * 0.45);
    particle.oy =
      (Math.random() * 2 - 1) * this.halfH * (0.55 + Math.random() * 0.45);
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(this.frame);

    const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0.0001), 0.033);
    this.lastTime = now;
    this.elapsed += dt;

    // 团块中心：线框正中 + 一点缓慢的漂移。
    const cx = this.width / 2 + Math.sin(this.elapsed * 0.42) * CLUMP_DRIFT;
    const cy = this.height / 2 + Math.cos(this.elapsed * 0.31) * CLUMP_DRIFT;

    const damping = Math.exp(-SPRING_DAMP * dt);
    const { x: px, y: py, inside: pointerInside } = this.pointer;
    const repelSq = REPEL_RADIUS * REPEL_RADIUS;

    for (const particle of this.particles) {
      particle.phase += particle.phaseSpeed * dt;

      const tx = cx + particle.ox;
      const ty = cy + particle.oy;

      // 弹簧拉向目标位置。
      particle.vx += (tx - particle.x) * SPRING * dt;
      particle.vy += (ty - particle.y) * SPRING * dt;

      // 自由游走的底噪，让团块始终有呼吸感。
      particle.vx += Math.sin(particle.phase) * DRIFT_SPEED * dt;
      particle.vy += Math.cos(particle.phase * 0.8) * DRIFT_SPEED * dt;

      // 鼠标排斥：靠近指针的粒子被推开（与背景光球的吸引相反）。
      if (pointerInside) {
        const dx = particle.x - px;
        const dy = particle.y - py;
        const distSq = dx * dx + dy * dy;
        if (distSq < repelSq && distSq > 0.0001) {
          const distance = Math.sqrt(distSq);
          const falloff = 1 - distance / REPEL_RADIUS;
          const push = REPEL_FORCE * falloff * falloff * dt;
          particle.vx += (dx / distance) * push;
          particle.vy += (dy / distance) * push;
        }
      }

      particle.vx *= damping;
      particle.vy *= damping;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    }

    this.render();
  };

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    for (const particle of this.particles) {
      const r = particle.radius;
      const gradient = context.createRadialGradient(
        particle.x - r * 0.3,
        particle.y - r * 0.35,
        r * 0.08,
        particle.x,
        particle.y,
        r,
      );
      if (this.tone === 'white') {
        // 白色：亮度没法再分层，改靠 alpha + radius 表现体积（radius 已随 depth）。
        const alpha = particle.baseAlpha;
        gradient.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, alpha * 1.15)})`);
        gradient.addColorStop(0.55, `rgba(255, 255, 255, ${alpha})`);
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      } else {
        gradient.addColorStop(0, `hsla(${this.hue}, 60%, ${60 + particle.depth * 14}%, ${particle.baseAlpha})`);
        gradient.addColorStop(0.55, `hsla(${this.hue}, 56%, ${44 + particle.depth * 10}%, ${particle.baseAlpha * 0.9})`);
        gradient.addColorStop(1, `hsla(${this.hue}, 50%, ${34 + particle.depth * 8}%, 0)`);
      }

      context.fillStyle = gradient;
      context.beginPath();
      context.arc(particle.x, particle.y, r, 0, Math.PI * 2);
      context.fill();
    }
  }
}
