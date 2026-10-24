/**
 * 背景点阵——参考站 `s-work` 里那块 canvas。
 *
 * 参考站的做法（逐字对齐）：
 *   - 24px 网格铺满 **1.2 倍视口**（比屏幕大一圈，缩放时不会露边），居中对齐；
 *   - 每个点记下自己相对视口中心的 `(dx, dy)`；
 *   - 每帧画在 `(x + dx * (1 - pointsProgress) * 0.2 + flowX, y + dy * (1 - pointsProgress) * 0.2)`。
 *
 * 于是有两层运动叠加：
 *   1. `pointsProgress` 从 0 → 1 再回到 0，让整片点阵从「散开」收成原网格（再散开）；
 *   2. `animationProgress` 一路涨到 1e4，取模后给出一个**水平传送带**偏移 `flowX`，
 *      所以点阵在纵向收缩之外还在横向持续流动。
 */

import { gsap } from './gsap-support';

/** 网格间距（CSS 像素）。参考站 24。 */
const GRID = 24;

/** 网格覆盖倍数：铺满 1.2 倍视口。 */
const OVERSCAN = 1.2;

/** canvas 支持的最高 DPR，避免 4K 屏上无谓地画四倍像素。 */
const MAX_DPR = 2;

interface Point {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
}

export interface WorkPointsHandle {
  readonly element: HTMLCanvasElement;
  resize(): void;
  draw(pointsProgress: number, animationProgress: number): void;
  dispose(): void;
}

export function createWorkPoints(color?: string): WorkPointsHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 's__canvas';

  const context = canvas.getContext('2d');
  const points: Point[] = [];

  let width = 1;
  let height = 1;
  let dotColor = color ?? '';

  const resolveColor = (): string => {
    if (dotColor) return dotColor;
    const fromCss = getComputedStyle(canvas).getPropertyValue('--work-dot').trim();
    dotColor = fromCss || 'rgba(63, 125, 88, 0.34)';
    return dotColor;
  };

  const resize = (): void => {
    // 参考站把 canvas 的像素尺寸直接设为视口尺寸（1:1）。这里按 DPR 放大再用
    // `setTransform` 还原 CSS 像素坐标，点更锐利，几何公式一字不改。
    width = window.innerWidth;
    height = window.innerHeight;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    context?.setTransform(dpr, 0, 0, dpr, 0, 0);

    points.length = 0;
    const cols = Math.ceil((width * OVERSCAN) / GRID) + 1;
    const rows = Math.ceil((height * OVERSCAN) / GRID) + 1;
    const padX = (cols * GRID - width) / 2;
    const padY = (rows * GRID - height) / 2;
    const centerX = width / 2;
    const centerY = height / 2;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * GRID - padX;
        const y = row * GRID - padY;
        points.push({ x, y, dx: centerX - x, dy: centerY - y });
      }
    }
  };

  const draw = (pointsProgress: number, animationProgress: number): void => {
    if (!context) return;
    // 传送带：animationProgress 会涨到 1e4，取模后落回一格间距内。
    const flow = (((animationProgress * -0.05) % GRID) + GRID) % GRID;
    const spread = (1 - pointsProgress) * 0.2;

    context.clearRect(0, 0, width, height);
    context.fillStyle = resolveColor();
    for (const point of points) {
      context.fillRect(
        Math.round(point.x + point.dx * spread + flow),
        Math.round(point.y + point.dy * spread),
        1,
        1,
      );
    }
  };

  resize();

  return {
    element: canvas,
    resize: () => {
      // 换尺寸后颜色可能随主题变了，重新取一次。
      dotColor = '';
      resize();
    },
    draw,
    dispose: () => {
      gsap.killTweensOf(canvas);
      canvas.remove();
    },
  };
}
