/**
 * 右框里的「多阶段对比」组件：N 张同尺寸的图完全重叠，用 N-1 根细线切开，
 * 左 → 右 依次露出「白模 → 初步渲染 → 后期处理」。
 *
 * 和 orb-field / swarm-field 一样是「带句柄的视觉场」，但有一处关键区别：**它在
 * `prefers-reduced-motion` 下不能整体早退**——静态呈现和拖拽都必须照常可用，只在
 * `playSweep()` 里把扫动动画降级成「直接落到静止位」。
 *
 * 全部几何都只是 0..1 的比例（`positions`），写进 CSS 时换算成百分比：
 *
 *   layer i 的可见区间 = [i === 0 ? 0 : p[i-1], i === n-1 ? 1 : p[i]]
 *   即 clip-path: inset(0 (1-右端)% 0 左端%)
 *
 * 只对 **根元素的 opacity** 挂 CSS 过渡（由外部的 `.is-settled` 控制开关）；
 * `clip-path` 与线的 `left` 一律不挂——它们由 rAF 逐帧写，挂了就会互相打架，
 * 这条纪律和 `.skills__card` 上 `transition: none` 的用意一致。
 */

import { prefersReducedMotion } from './text-support';

/** 一层（一个制作阶段的图）。`content/skills.ts` 里的 `CompareLayer` 结构上兼容。 */
export interface CompareLayerSpec {
  src: string;
  alt: string;
}

export interface ImageCompareOptions {
  /** 挂载宿主（传 `.skills__frame--swarm`，继承 16:9 尺寸）。 */
  host: HTMLElement;
  /** 初始图层；也可以之后再 `setLayers()`。 */
  layers?: readonly CompareLayerSpec[];
  /** 各分隔线的静止位置（0..1）。缺省为等分，例如 2 根线 → [1/3, 2/3]。 */
  restPositions?: readonly number[];
  /** 相邻两根线的最小间距（0..1）。 */
  minGap?: number;
}

export interface ImageCompareHandle {
  /** 根元素（`.compare`）。 */
  readonly element: HTMLElement;
  /** 换一组图。srcs 完全一致时是空操作，避免反复重建 <img> 导致闪烁。 */
  setLayers(layers: readonly CompareLayerSpec[]): void;
  show(): void;
  hide(): void;
  /** 入场：两根线先后从左扫到右，再回弹并停在静止位。 */
  playSweep(): void;
  cancelSweep(): void;
  dispose(): void;
}

const DEFAULT_MIN_GAP = 0.06;
/** 扫过阶段占整条时长的比例（其余用于回弹收位）。 */
const TRAVEL = 0.44;
/** 单根线的扫动总时长（ms）。 */
const SWEEP_MS = 720;
/** 后一根线相对前一根的延迟（ms），形成「依次」的节奏。 */
const SWEEP_STAGGER = 170;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
/** 末端越界再收回的缓动，回弹手感就来自这里。 */
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** 单根线在局部进度 u ∈ [0,1] 上的位置：先 0 → 1 扫过去，再回弹落到 rest。 */
const sweepValue = (u: number, rest: number): number => {
  if (u <= 0) return 0;
  if (u >= 1) return rest;
  const travel = easeOutCubic(Math.min(1, u / TRAVEL));
  const settle = Math.max(0, (u - TRAVEL) / (1 - TRAVEL));
  return travel - (1 - rest) * easeOutBack(settle);
};

export function createImageCompare(options: ImageCompareOptions): ImageCompareHandle {
  const root = document.createElement('div');
  root.className = 'compare';

  const minGap = options.minGap ?? DEFAULT_MIN_GAP;

  let layers: readonly CompareLayerSpec[] = options.layers ?? [];
  let positions: number[] = [];
  let restPositions: readonly number[] = options.restPositions ?? [];
  let layerEls: HTMLElement[] = [];
  let lineEls: HTMLElement[] = [];

  let sweepFrame = 0;
  let sweepStart = 0;
  let dragIndex = -1;
  let dragRect: DOMRect | null = null;
  let disposed = false;

  /** 等分静止位；也可由 options.restPositions 覆盖。 */
  const restFor = (count: number): number[] => {
    const explicit = options.restPositions;
    if (explicit && explicit.length === count) return explicit.slice();
    return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
  };

  /**
   * 把比例收紧到「不与邻居重叠」的合法区间，再写进 CSS。
   * 从左到右保证 `p[j] ≥ p[j-1] + gap`，再从右到左保证 `p[j] ≤ p[j+1] - gap`。
   */
  const clampSequence = (input: readonly number[]): number[] => {
    const out = input.map(clamp01);
    for (let i = 1; i < out.length; i += 1) {
      out[i] = Math.max(out[i], out[i - 1] + minGap);
    }
    for (let i = out.length - 2; i >= 0; i -= 1) {
      out[i] = Math.min(out[i], out[i + 1] - minGap);
    }
    return out.map(clamp01);
  };

  /** 唯一的写点：把 positions 刷成 clip-path + left + aria。不做任何布局读。 */
  const write = (): void => {
    const count = layers.length;
    layerEls.forEach((layer, index) => {
      const start = index === 0 ? 0 : positions[index - 1];
      const end = index === count - 1 ? 1 : positions[index];
      const left = (clamp01(start) * 100).toFixed(4);
      const right = ((1 - clamp01(end)) * 100).toFixed(4);
      layer.style.clipPath = `inset(0 ${right}% 0 ${left}%)`;
    });
    lineEls.forEach((line, index) => {
      const value = clamp01(positions[index]);
      line.style.left = `${(value * 100).toFixed(4)}%`;
      const percent = Math.round(value * 100);
      line.setAttribute('aria-valuenow', String(percent));
      line.setAttribute('aria-valuetext', `${percent}%`);
    });
  };

  /** 拖动 / 键盘改的是某一根线；与邻居的间距由 clampSequence 兜底。 */
  const setLine = (index: number, value: number): void => {
    if (index < 0 || index >= positions.length) return;
    const next = positions.slice();
    next[index] = clamp01(value);
    positions = clampSequence(next);
    write();
  };

  const cancelSweep = (): void => {
    if (sweepFrame) {
      window.cancelAnimationFrame(sweepFrame);
      sweepFrame = 0;
    }
  };

  // -- 指针 -------------------------------------------------------------------

  const onLinePointerDown = (index: number) => (event: PointerEvent): void => {
    // 只接主键（鼠标）；触屏 / 笔没有 button 概念。
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    // 线的子树在右栏里，别让事件冒到卡片命中区去。
    event.stopPropagation();
    // 扫动途中抓住线：就地接管，从当前比例接着拖，不跳变。
    cancelSweep();
    dragIndex = index;
    dragRect = root.getBoundingClientRect();
    lineEls[index].setPointerCapture(event.pointerId);
  };

  const onLinePointerMove = (event: PointerEvent): void => {
    if (dragIndex < 0) return;
    if (!dragRect || dragRect.width <= 0) return;
    setLine(dragIndex, (event.clientX - dragRect.left) / dragRect.width);
  };

  const onLinePointerUp = (event: PointerEvent): void => {
    if (dragIndex < 0) return;
    const line = lineEls[dragIndex];
    if (line.hasPointerCapture(event.pointerId)) line.releasePointerCapture(event.pointerId);
    dragIndex = -1;
    dragRect = null;
  };

  // -- 键盘 -------------------------------------------------------------------

  const onLineKeyDown = (index: number) => (event: KeyboardEvent): void => {
    const current = positions[index] ?? 0;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = current - (event.shiftKey ? 0.1 : 0.01);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = current + (event.shiftKey ? 0.1 : 0.01);
        break;
      case 'PageDown':
        next = current - 0.1;
        break;
      case 'PageUp':
        next = current + 0.1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    cancelSweep();
    setLine(index, next);
  };

  // -- 构建 -------------------------------------------------------------------

  const clear = (): void => {
    for (const line of lineEls) line.remove();
    for (const layer of layerEls) layer.remove();
    layerEls = [];
    lineEls = [];
  };

  const build = (): void => {
    clear();
    const count = layers.length;
    if (count < 2) return;

    layers.forEach((spec, index) => {
      const layer = document.createElement('div');
      layer.className = 'compare__layer';
      // DOM 顺序即层叠顺序：第一层在最底，最后一层在最上——左端露最早阶段，
      // 右端露最终阶段，拖动时三段的先后关系一眼能读出来。
      layer.style.zIndex = String(index + 1);

      const img = document.createElement('img');
      img.className = 'compare__img';
      img.src = spec.src;
      img.alt = spec.alt;
      img.draggable = false;
      img.decoding = 'async';
      layer.append(img);
      root.append(layer);
      layerEls.push(layer);
    });

    restPositions = restFor(count - 1);
    positions = clampSequence(restPositions);

    for (let index = 0; index < count - 1; index += 1) {
      const line = document.createElement('div');
      line.className = 'compare__line';
      line.tabIndex = 0;
      line.setAttribute('role', 'slider');
      line.setAttribute('aria-orientation', 'horizontal');
      line.setAttribute(
        'aria-label',
        `${layers[index].alt} 与 ${layers[index + 1].alt} 的分界线`,
      );
      line.setAttribute('aria-valuemin', '0');
      line.setAttribute('aria-valuemax', '100');
      line.style.zIndex = String(20 + index);

      const hit = document.createElement('div');
      hit.className = 'compare__line-hit';
      const bar = document.createElement('div');
      bar.className = 'compare__line-bar';
      const grip = document.createElement('div');
      grip.className = 'compare__line-grip';
      line.append(hit, bar, grip);

      line.addEventListener('pointerdown', onLinePointerDown(index));
      line.addEventListener('pointermove', onLinePointerMove);
      line.addEventListener('pointerup', onLinePointerUp);
      line.addEventListener('pointercancel', onLinePointerUp);
      line.addEventListener('keydown', onLineKeyDown(index));

      root.append(line);
      lineEls.push(line);
    }

    write();
  };

  const setLayers = (next: readonly CompareLayerSpec[]): void => {
    const same =
      next.length === layers.length && next.every((spec, index) => spec.src === layers[index].src);
    if (same) return;
    layers = next;
    build();
  };

  // -- 扫动 -------------------------------------------------------------------

  const step = (now: number): void => {
    if (disposed) return;
    const elapsed = now - sweepStart;
    const count = positions.length;
    const raw = positions.map((_value, index) =>
      sweepValue((elapsed - index * SWEEP_STAGGER) / SWEEP_MS, restPositions[index]),
    );
    // 扫动期间也走同一套间距收紧：两根线保持「前者在前、后者在后」，
    // 越过时不会让中间那层的 clip-path 塌成空矩形。
    positions = clampSequence(raw);
    write();

    if (elapsed >= SWEEP_MS + SWEEP_STAGGER * (count - 1)) {
      sweepFrame = 0;
      positions = clampSequence(restPositions);
      write();
      return;
    }
    sweepFrame = window.requestAnimationFrame(step);
  };

  const playSweep = (): void => {
    if (disposed) return;
    cancelSweep();
    // 静态呈现：直接落在静止位，不跑动画（拖拽 / 键盘照常可用）。
    if (prefersReducedMotion()) {
      positions = clampSequence(restPositions);
      write();
      return;
    }
    if (positions.length === 0) return;
    sweepStart = performance.now();
    sweepFrame = window.requestAnimationFrame(step);
  };

  // 隐藏时不仅透明，还要让分隔线彻底不吃指针——否则看不见的线依然能拦住右栏。
  const show = (): void => {
    root.style.opacity = '1';
    root.classList.add('is-visible');
  };
  const hide = (): void => {
    root.style.opacity = '0';
    root.classList.remove('is-visible');
  };

  options.host.append(root);
  build();

  return {
    element: root,
    setLayers,
    show,
    hide,
    playSweep,
    cancelSweep,
    dispose: () => {
      disposed = true;
      cancelSweep();
      root.remove();
      layerEls = [];
      lineEls = [];
    },
  };
}
