/**
 * The hero's leaf field.
 *
 * Leaves are simulated in viewport (screen) space on a fixed canvas, so they
 * stay put while the page scrolls underneath them. Each frame the current
 * screen boxes of the wordmark and the ground are measured and handed to the
 * physics as moving colliders, which lets the title and ground push the leaves
 * around as they travel past.
 */

import { createLeafShapes, LEAF_PALETTE, traceLeaf, type LeafShape } from './leaf-shape';
import { createLeaf, stepLeaf, type Collider, type Leaf } from './leaf-physics';

export interface LeafFieldOptions {
  /** Element the fixed canvas is attached to (normally `document.body`). */
  host: HTMLElement;
  /** Heading whose individual glyphs behave as platforms. */
  title: HTMLElement;
  /** Plate below the title that leaves settle on. */
  ground: HTMLElement;
  /** First section; the shower only runs while it is still on screen. */
  scene: HTMLElement;
}

/** Delay after mount before the first leaf drops, in milliseconds. */
const START_DELAY = 300;

/**
 * Leaves are released on a clock rather than only to refill a quota, so the
 * shower is continuous and evenly spaced instead of stuttering (one out, one
 * in). The two rates below are the knob for how busy the scene feels.
 */
const LEAVES_PER_SECOND = 14;
/** While the opening burst lasts, leaves arrive this many times faster. */
const SHOWER_BURST_RATE = 2.4;
/** How long the opening burst lasts before settling to the steady rate. */
const SHOWER_DURATION = 10000;
/** Steady ceiling per viewport area, clamped to the range below. */
const AREA_PER_LEAF = 11000;
const MIN_LEAVES = 34;
const MAX_LEAVES = 96;
/** Hard cap on spawns in one frame, so a long dt cannot dump the whole field. */
const MAX_SPAWN_PER_FRAME = 4;

/** Radius of the cursor gust, in px. */
const WIND_RADIUS = 240;
/** Cursor speed (px/s) below which no gust is produced. */
const WIND_MIN_SPEED = 24;
/** How strongly the gust follows the cursor's own velocity. */
const WIND_FORCE = 6.2;
/** Extra lift so a brush past the pointer picks leaves up off the surface. */
const WIND_LIFT = 420;
/** Slight outward scatter so stirred leaves don't move as one rigid block. */
const WIND_SCATTER = 280;
/** Speed (px/s) at which the gust is at full strength. */
const WIND_FULL_SPEED = 700;

/** Fraction of a glyph's advance box that is treated as solid ink. */
const GLYPH_INK_RATIO = 0.36;
/** Letter-spacing adds a trailing gap after the last glyph; shift back for it. */
const TRAILING_SPACING_RATIO = 0.5;

export function createLeafField(options: LeafFieldOptions): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }
  const field = new LeafField(options);
  field.start();
  return () => field.destroy();
}

/** Screen box plus measured velocity, used as a moving collision surface. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

class LeafField {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly host: HTMLElement;
  private readonly title: HTMLElement;
  private readonly ground: HTMLElement;
  private readonly scene: HTMLElement;
  private readonly shapes: LeafShape[] = createLeafShapes(14);
  private readonly leaves: Leaf[] = [];
  private readonly range = document.createRange();
  private readonly pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, active: false };
  private readonly samples: Array<{ x: number; y: number; t: number }> = [];
  private readonly previousRects = new Map<string, Rect>();

  private width = 0;
  private height = 0;
  private dpr = 1;
  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private target = MIN_LEAVES;
  /** Fractional leaves owed to the steady clock, carried between frames. */
  private spawnDebt = 0;
  /** Whether the opening population has been scattered down the screen once. */
  private seeded = false;
  private disposed = false;

  constructor(options: LeafFieldOptions) {
    this.host = options.host;
    this.title = options.title;
    this.ground = options.ground;
    this.scene = options.scene;

    const canvas = document.createElement('canvas');
    canvas.className = 'leaf-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('2D canvas context is unavailable');
    }

    this.canvas = canvas;
    this.context = context;
    this.host.append(canvas);
    this.resize();
  }

  start(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerMove, { passive: true });
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
    window.removeEventListener('pagehide', this.destroy);
    this.canvas.remove();
  };

  // -- sizing ---------------------------------------------------------------

  private onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.target = Math.round(
      Math.min(MAX_LEAVES, Math.max(MIN_LEAVES, (this.width * this.height) / AREA_PER_LEAF)),
    );
  }

  // -- pointer wind ---------------------------------------------------------

  private onPointerMove = (event: PointerEvent): void => {
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    this.pointer.active = true;
    this.samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
    if (this.samples.length > 5) this.samples.shift();
  };

  private updatePointerVelocity(now: number): void {
    if (!this.pointer.active) {
      this.pointer.vx = 0;
      this.pointer.vy = 0;
      return;
    }

    // Drop stale samples so a resting cursor produces no gust.
    while (this.samples.length > 1 && now - this.samples[0].t > 120) {
      this.samples.shift();
    }

    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const span = (newest.t - oldest.t) / 1000;
    if (span <= 0.001 || now - newest.t > 120) {
      this.pointer.vx = 0;
      this.pointer.vy = 0;
      return;
    }
    this.pointer.vx = (newest.x - oldest.x) / span;
    this.pointer.vy = (newest.y - oldest.y) / span;
  }

  private applyWind(dt: number): void {
    const { x, y, vx, vy, active } = this.pointer;
    if (!active) return;

    // A resting cursor is not wind: only a moving pointer stirs the leaves.
    const speed = Math.hypot(vx, vy);
    if (speed < WIND_MIN_SPEED) return;
    const strength = Math.min(speed / WIND_FULL_SPEED, 1.5);

    for (const leaf of this.leaves) {
      const dx = leaf.x - x;
      const dy = leaf.y - y;
      const distance = Math.hypot(dx, dy);
      if (distance > WIND_RADIUS) continue;

      const falloff = 1 - distance / WIND_RADIUS;
      // Blow along the direction of travel, lift a little, scatter outwards.
      leaf.vx += vx * WIND_FORCE * falloff * dt;
      leaf.vy += vy * WIND_FORCE * falloff * dt;
      leaf.vy -= WIND_LIFT * strength * falloff * dt;
      if (distance > 0.001) {
        leaf.vx += (dx / distance) * WIND_SCATTER * strength * falloff * dt;
        leaf.vy += (dy / distance) * WIND_SCATTER * strength * falloff * dt;
      }
      leaf.spin += (Math.random() - 0.5) * 14 * falloff * dt;

      if (leaf.resting && speed * falloff > 60) {
        leaf.resting = false;
        leaf.restTimer = 0;
      }
    }
  }

  // -- colliders ------------------------------------------------------------

  private gatherColliders(dt: number): Collider[] {
    const colliders: Collider[] = [];
    const seen = new Map<string, Rect>();

    const add = (
      key: string,
      left: number,
      top: number,
      right: number,
      bottom: number,
    ): void => {
      if (right - left <= 0 || bottom - top <= 0) return;
      // 开场动画会把整个板块钉住很久，这段时间不让颗粒进来捣乱。
      if (document.body.dataset.identityPinned === '1') return;
      const before = this.previousRects.get(key);
      seen.set(key, { left, top, right, bottom });
      colliders.push({
        left,
        top,
        right,
        bottom,
        vx: before ? (left - before.left) / dt : 0,
        vy: before ? (top - before.top) / dt : 0,
        active: true,
      });
    };

    // 舞台层是 fixed 的，它本身就是这片“纸”；颗粒只往上落。
    const paperRect = this.ground.getBoundingClientRect();
    if (paperRect.bottom > -40 && paperRect.top < this.height + 40) {
      add('paper', paperRect.left, paperRect.top, paperRect.right, paperRect.bottom);
    }

    this.addGlyphColliders(add);

    this.previousRects.clear();
    seen.forEach((value, key) => this.previousRects.set(key, value));
    return colliders;
  }

  private addGlyphColliders(
    add: (key: string, left: number, top: number, right: number, bottom: number) => void,
  ): void {
    const node = this.title.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;

    const text = node as Text;
    const titleRect = this.title.getBoundingClientRect();
    if (titleRect.bottom < -40 || titleRect.top > this.height + 40) return;

    const length = text.data.length;
    this.range.setStart(text, 0);
    this.range.setEnd(text, length);
    const advance = this.range.getBoundingClientRect().width / length;

    // `getBoundingClientRect` on a character range reports the full advance box
    // (ink plus the side bearings letter-spacing adds), which is wider than the
    // visible glyph. Narrow it towards the ink and shift back by half of the
    // trailing spacing so the box stays centred on each character.
    const halfInk = advance * GLYPH_INK_RATIO * 0.5;
    const trim = advance * TRAILING_SPACING_RATIO * 0.5;

    for (let index = 0; index < length; index += 1) {
      const character = text.data[index];
      if (!character || character.trim() === '') continue;

      this.range.setStart(text, index);
      this.range.setEnd(text, index + 1);
      const rect = this.range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < -40 || rect.top > this.height + 40) continue;

      const centreX = (rect.left + rect.right) / 2 - trim;
      add(`glyph-${index}`, centreX - halfInk, rect.top, centreX + halfInk, rect.bottom);
    }
  }

  // -- spawning -------------------------------------------------------------

  private maintainSpawn(dt: number): void {
    // Once the first section has scrolled away there is no more falling: the
    // shower stops and only the leaves already in flight are left to settle.
    if (this.scene.getBoundingClientRect().bottom <= this.height * 0.25) {
      this.spawnDebt = 0;
      return;
    }

    const sinceStart = this.elapsed * 1000 - START_DELAY;
    if (sinceStart < 0) return;

    // First frame of the shower: scatter a starter population down the whole
    // height so the opening reads as a full scene rather than a slow trickle.
    if (!this.seeded) {
      this.seeded = true;
      const seedCount = Math.round(this.target * 0.7);
      for (let index = 0; index < seedCount; index += 1) this.spawn(true);
    }

    // The opening shower arrives faster, then settles to a constant rate: a
    // leaf every 1/LEAVES_PER_SECOND seconds regardless of how many have left.
    const burst = Math.max(0, 1 - sinceStart / SHOWER_DURATION);
    const rate = LEAVES_PER_SECOND * (1 + (SHOWER_BURST_RATE - 1) * burst);

    // The steady rate governs spacing; the ceiling only stops a pile-up when
    // settling leaves linger, so a slowly clearing field never starves.
    this.spawnDebt = Math.min(this.spawnDebt + rate * dt, MAX_SPAWN_PER_FRAME);

    let spawned = 0;
    while (this.spawnDebt >= 1 && spawned < MAX_SPAWN_PER_FRAME) {
      if (this.leaves.length >= this.target) break;
      this.spawn(false);
      this.spawnDebt -= 1;
      spawned += 1;
    }
    if (spawned === 0 && this.spawnDebt >= 1) {
      // At the ceiling: hold the debt so the shower resumes immediately once
      // leaves start dying off, instead of stalling.
      this.spawnDebt = Math.min(this.spawnDebt, 1);
    }
  }

  private spawn(scatterVertically: boolean): void {
    const depth = Math.random();
    const size = (13 + Math.random() * 25) * (0.75 + depth * 0.7);
    const x = -60 + Math.random() * (this.width + 120);
    const y = scatterVertically
      ? -Math.random() * this.height * 0.85
      : -size * 2 - Math.random() * 90;

    this.leaves.push(
      createLeaf({
        x,
        y,
        size,
        depth,
        shapeIndex: Math.floor(Math.random() * this.shapes.length),
        paletteIndex: Math.floor(Math.random() * LEAF_PALETTE.length),
      }),
    );
  }

  // -- loop -----------------------------------------------------------------

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(this.frame);

    // Guard the lower bound so collider velocity never divides by zero, and the
    // upper bound so a resumed/backgrounded tab can't teleport the leaves.
    const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0.0001), 0.033);
    this.lastTime = now;
    this.elapsed += dt;

    this.updatePointerVelocity(now);
    this.maintainSpawn(dt);
    this.applyWind(dt);

    const colliders = this.gatherColliders(dt);
    const pointerSpeed = Math.hypot(this.pointer.vx, this.pointer.vy);
    const breezeAmplitude = 16 + Math.min(pointerSpeed, 1400) * 0.05;

    for (const leaf of this.leaves) {
      stepLeaf(leaf, {
        dt,
        time: this.elapsed,
        width: this.width,
        height: this.height,
        colliders,
        breezeAmplitude,
      });
    }

    for (let index = this.leaves.length - 1; index >= 0; index -= 1) {
      if (this.leaves[index].dead) this.leaves.splice(index, 1);
    }

    this.render();
  };

  private render(): void {
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);

    for (const leaf of this.leaves) {
      context.save();
      context.globalAlpha = leaf.opacity;
      context.translate(leaf.x, leaf.y);
      context.rotate(leaf.rotation);
      // A gentle squash keeps settled leaves from looking like flat stickers.
      context.scale(1, 1 + Math.sin(leaf.flutter) * 0.18);

      const shape = this.shapes[leaf.shapeIndex];
      const radius = leaf.size * 0.5;
      traceLeaf(context, shape, radius);

      const palette = LEAF_PALETTE[leaf.paletteIndex];
      context.fillStyle = palette.fill;
      context.fill();

      context.lineWidth = Math.max(0.8, radius * 0.14);
      context.strokeStyle = palette.stroke;
      context.stroke();

      // Midrib at larger sizes only, to hint at depth without visual noise.
      if (leaf.size > 22) {
        context.beginPath();
        context.moveTo(0, radius * 0.2);
        context.lineTo(0, -radius * 0.82);
        context.lineWidth = Math.max(0.6, radius * 0.07);
        context.globalAlpha = leaf.opacity * 0.55;
        context.stroke();
      }

      context.restore();
    }
  }
}
