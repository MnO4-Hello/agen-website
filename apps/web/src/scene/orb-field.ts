/**
 * “我会什么？”的背景：浅绿页面上缓慢上浮的绿色光球。
 *
 * 光球在屏幕空间里模拟，用 `depth`（0 远 → 1 近）同时驱动三件事：
 *
 *   - **大小**：越近越大，配合 1/depth 的透明度衰减做出景深；
 *   - **速度**：越近上浮越快，远的那批慢悠悠地飘，形成视差；
 *   - **亮度**：越近越实、光晕越亮，视觉上就更“贴脸”。
 *
 * 底座是整站那层浅绿，所以球不能用浅色——用饱和度更高的绿、中心带一点亮心，
 * 靠 `createRadialGradient` 在边缘把 alpha 收到 0，出来是一颗有体积的小光球；
 * 近处的球再补一圈更淡的光晕，强化“光点”的读感。
 *
 * 鼠标是引力源：半径内的球会被快速吸向指针（`ATTRACT_FORCE` 调得偏大，让
 * 效果一眼可见），离开后靠阻尼自然散开、重新上浮。
 */

export interface OrbFieldOptions {
  /** 画布挂载到的元素。 */
  host: HTMLElement;
  /** 画布是否铺满宿主（fixed 全屏），默认 true。 */
  fixed?: boolean;
  /** 光球基础色相（HSL 的 H），默认 152（清爽的绿）。 */
  hue?: number;
  /** 配色：`'brand'` 用上面的色相（默认）｜`'white'` 画成白色。 */
  tone?: 'brand' | 'white';
}

export interface OrbFieldHandle {
  dispose(): void;
}

/** 每多少 px² 视口放一颗球，再钳到下面的区间。 */
const AREA_PER_ORB = 26000;
const MIN_ORBS = 46;
const MAX_ORBS = 130;
/** 向上的漂移速度范围（px/s），实际速度再乘深度系数。 */
const RISE_MIN = 9;
const RISE_MAX = 22;
/** 引力作用半径（px）。 */
const ATTRACT_RADIUS = 300;
/** 引力强度（px/s²）。调大即“吸力更强”。 */
const ATTRACT_FORCE = 2600;
/** 被吸住时速度上限（px/s），避免穿过指针后飞走。 */
const ATTRACT_MAX_SPEED = 560;
/** 阻尼：速度按这个速率衰减，让球被吸过来后稳稳贴上。 */
const LINEAR_DAMP = 1.6;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

interface Orb {
  /** 屏幕坐标（px）。 */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 远 → 1 近。 */
  depth: number;
  /** 半径（px）。 */
  radius: number;
  /** 该球自己的上浮速度（px/s，正值向上）。 */
  rise: number;
  /** 基础不透明度。 */
  baseAlpha: number;
  phase: number;
  phaseSpeed: number;
  /** 被吸引力带动时的额外扰动。 */
  wobble: number;
}

export function createOrbField(options: OrbFieldOptions): OrbFieldHandle {
  if (typeof window === 'undefined') return { dispose: () => {} };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { dispose: () => {} };
  }
  const field = new OrbField(options);
  field.start();
  return { dispose: () => field.destroy() };
}

class OrbField {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly host: HTMLElement;
  private readonly hue: number;
  private readonly tone: 'brand' | 'white';
  private readonly orbs: Orb[] = [];
  private readonly pointer = { x: -1e4, y: -1e4, active: false };

  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private target = MIN_ORBS;
  /** 是否跟随页面滚动重算相框（fixed 画布不必）。 */
  private readonly tracksScroll: boolean;
  private disposed = false;

  constructor(options: OrbFieldOptions) {
    this.host = options.host;
    this.hue = options.hue ?? 152;
    this.tone = options.tone ?? 'brand';
    this.tracksScroll = options.fixed === false;

    const canvas = document.createElement('canvas');
    canvas.className = 'orb-canvas';
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
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerMove, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('pagehide', this.destroy);

    this.lastTime = performance.now();
    this.raf = window.requestAnimationFrame(this.frame);
  }

  destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerdown', this.onPointerMove);
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('pagehide', this.destroy);
    this.canvas.remove();
  };

  // -- sizing ---------------------------------------------------------------

  private onResize = (): void => {
    this.resize();
  };

  private onScroll = (): void => {
    if (!this.tracksScroll) return;
    // 画布贴在一个随页面滚动的宿主里：滚动时用 getBoundingClientRect 重新对齐，
    // 并且让球跟着宿主一起走（它们在宿主坐标系里，不是屏幕坐标系）。
    const rect = this.canvas.getBoundingClientRect();
    this.hostOffsetX = rect.left;
    this.hostOffsetY = rect.top;
  };

  private hostOffsetX = 0;
  private hostOffsetY = 0;

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = this.tracksScroll ? Math.max(1, rect.width) : window.innerWidth;
    this.height = this.tracksScroll ? Math.max(1, rect.height) : window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    if (this.tracksScroll) this.onScroll();

    this.target = Math.round(
      clamp((this.width * this.height) / AREA_PER_ORB, MIN_ORBS, MAX_ORBS),
    );
    this.syncPopulation();
  }

  private syncPopulation(): void {
    while (this.orbs.length < this.target) this.spawn(true);
    if (this.orbs.length > this.target) this.orbs.length = this.target;
  }

  // -- pointer --------------------------------------------------------------

  private onPointerMove = (event: PointerEvent): void => {
    if (this.tracksScroll) {
      this.pointer.x = event.clientX - this.hostOffsetX;
      this.pointer.y = event.clientY - this.hostOffsetY;
    } else {
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
    }
    this.pointer.active = true;
  };

  // -- spawning -------------------------------------------------------------

  private spawn(anywhere = false): void {
    const depth = Math.random();
    const radius = (1.6 + depth * 4.6) * (0.85 + Math.random() * 0.4);
    const orb: Orb = {
      x: Math.random() * this.width,
      // 初始时铺满整屏，之后新生成的球从底部进入。
      y: anywhere ? Math.random() * this.height : this.height + radius + Math.random() * 40,
      vx: 0,
      vy: 0,
      depth,
      radius,
      rise: (RISE_MIN + Math.random() * (RISE_MAX - RISE_MIN)) * (0.45 + depth * 0.75),
      baseAlpha: clamp(0.3 + depth * 0.55, 0.26, 0.85),
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: 0.4 + Math.random() * 1.1,
      wobble: 6 + Math.random() * 16,
    };
    this.orbs.push(orb);
  }

  private applyParticles(): void {
    if (!this.pointer.active) return;
    const { x, y } = this.pointer;
    const radiusSq = ATTRACT_RADIUS * ATTRACT_RADIUS;

    for (const orb of this.orbs) {
      const dx = x - orb.x;
      const dy = y - orb.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;

      const distance = Math.sqrt(distSq) || 1;
      const falloff = 1 - distance / ATTRACT_RADIUS;
      // 越近吸力越强，且近处的球（更大更亮）反应更明显。
      const pull = ATTRACT_FORCE * falloff * falloff * (0.6 + orb.depth * 0.8);
      orb.vx += (dx / distance) * pull * this.dt;
      orb.vy += (dy / distance) * pull * this.dt;

      const speed = Math.hypot(orb.vx, orb.vy);
      if (speed > ATTRACT_MAX_SPEED) {
        const scale = ATTRACT_MAX_SPEED / speed;
        orb.vx *= scale;
        orb.vy *= scale;
      }
      // 贴到指针附近时给一点切向扰动，让聚拢不成一坨死点。
      if (distance < 46) {
        orb.wobble += this.dt * 20;
      }
    }
  }

  // -- loop -----------------------------------------------------------------

  private dt = 1 / 60;

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(this.frame);

    const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0.0001), 0.033);
    this.lastTime = now;
    this.elapsed += dt;
    this.dt = dt;

    this.maintain();
    this.applyParticles();

    const damping = Math.exp(-LINEAR_DAMP * dt);
    for (const orb of this.orbs) {
      orb.phase += orb.phaseSpeed * dt;
      // 上浮 + 轻微的横向摆动，避免整片球像一堵墙。
      orb.vy -= orb.rise * dt;
      orb.vx += Math.sin(orb.phase) * orb.wobble * dt;

      orb.vx *= damping;
      orb.vy *= damping;
      orb.x += orb.vx * dt;
      orb.y += orb.vy * dt;

      // 出顶就回到屏幕底部，维持“持续上浮”的循环。
      if (orb.y + orb.radius < -20) {
        orb.y = this.height + orb.radius + Math.random() * 60;
        orb.x = Math.random() * this.width;
        orb.vx = 0;
        orb.vy = 0;
        orb.phase = Math.random() * Math.PI * 2;
      }
      if (orb.x < -orb.radius * 3) orb.x = this.width + orb.radius;
      else if (orb.x > this.width + orb.radius * 3) orb.x = -orb.radius;
    }

    this.render();
  };

  private maintain(): void {
    // 每帧补一颗，让空出来的位置被新球顶上——保持总数恒定、画面不断流。
    if (this.orbs.length < this.target) this.spawn();
  }

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    // 近处的球后画（盖在上面），先按 depth 升序排一遍。
    const ordered = [...this.orbs].sort((a, b) => a.depth - b.depth);
    const white = this.tone === 'white';

    for (const orb of ordered) {
      const r = orb.radius;

      // 近处的球先铺一层更淡的光晕，让它在浅绿底上也读得出是一颗“光点”。
      if (orb.depth > 0.6) {
        const halo = context.createRadialGradient(orb.x, orb.y, r * 0.7, orb.x, orb.y, r * 2.5);
        if (white) {
          halo.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, orb.baseAlpha * 0.26)})`);
          halo.addColorStop(1, 'rgba(255, 255, 255, 0)');
        } else {
          halo.addColorStop(0, `hsla(${this.hue}, 68%, 50%, ${orb.baseAlpha * 0.16})`);
          halo.addColorStop(1, `hsla(${this.hue}, 68%, 50%, 0)`);
        }
        context.fillStyle = halo;
        context.beginPath();
        context.arc(orb.x, orb.y, r * 2.5, 0, Math.PI * 2);
        context.fill();
      }

      const gradient = context.createRadialGradient(
        orb.x - r * 0.3,
        orb.y - r * 0.35,
        r * 0.1,
        orb.x,
        orb.y,
        r,
      );
      // 亮心（偏左上）→ 本体 → 边缘收到全透明：一颗有体积感的小光球。
      // 白色没有色相可分层，改把 depth 落到 alpha 上来保留景深（radius 本来
      // 也已随 depth 变化），中心补一点不透明度让近处的球接近纯白。
      if (white) {
        gradient.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1, orb.baseAlpha * 1.2)})`);
        gradient.addColorStop(0.55, `rgba(255, 255, 255, ${orb.baseAlpha})`);
        gradient.addColorStop(0.85, `rgba(255, 255, 255, ${orb.baseAlpha * 0.42})`);
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      } else {
        gradient.addColorStop(0, `hsla(${this.hue}, 66%, ${64 + orb.depth * 12}%, ${orb.baseAlpha})`);
        gradient.addColorStop(0.55, `hsla(${this.hue}, 62%, ${46 + orb.depth * 10}%, ${orb.baseAlpha * 0.94})`);
        gradient.addColorStop(0.85, `hsla(${this.hue}, 58%, ${38 + orb.depth * 8}%, ${orb.baseAlpha * 0.34})`);
        gradient.addColorStop(1, `hsla(${this.hue}, 54%, ${34 + orb.depth * 6}%, 0)`);
      }

      context.fillStyle = gradient;
      context.beginPath();
      context.arc(orb.x, orb.y, r, 0, Math.PI * 2);
      context.fill();
    }
  }
}
