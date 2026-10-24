/**
 * WORK 段的 SVG 遮罩——参考站 `.s-work .s__mask` 那一层，逐字移植 `setMask()`。
 *
 * 关键点是**窗口的形状与尺寸完全由 `.s__ruler` 决定**（不是我自己拍的常数）：
 * 那条竖尺在 CSS 里是 `width: min(16.6667%, 19.625rem); top: 10lvh; height: 80lvh;
 * left: calc(50% - var(--width)/2)`，于是观察窗就是这块矩形的位置与大小。
 *
 * 形状是**竖直胶囊**（stadium），不是圆角矩形：
 *
 *   M tl.x (tl.y+p)  A p p 0 0 1 tr.x (tr.y+p)     ← 上半圆，半径 p = 窗宽 / 2
 *   L br.x (br.y-p)  A p p 0 0 1 bl.x (bl.y-p)     ← 下半圆
 *   Z
 *
 * 三条 path 都是 `[整屏矩形, 窗口]` 的 evenodd 组合，也就是「一块挖了洞的遮片」：
 *
 *   path-outer  洞 = ruler 矩形            → 窗口外沿的描边
 *   path-inner  洞 = ruler 内缩 LIP 的矩形 → 窗口内沿的描边（随滚动下移 48px，形成双线错动）
 *   path-lines  横竖参考线，用 `clip-path: path(evenodd, …)` 裁进环里，只留在遮片上
 *
 * `maxScale = 视口宽 / 半径`——放大到这个倍数时窗宽正好等于视口宽。
 */

/** 内唇宽度（px）：宽屏 16、窄屏 8（参考站按 767px 分界）。 */
const LIP_DESKTOP = 16;
const LIP_COMPACT = 8;

/** 竖线数量：宽屏 12、窄屏 8。 */
const V_LINES_DESKTOP = 12;
const V_LINES_COMPACT = 8;

/** 横线间距 = 遮罩高度的这个比例。 */
const H_LINE_RATIO = 0.1;

const COMPACT_MAX_WIDTH = 767;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface WorkMaskHandle {
  /** `.s__mask`——时间轴直接对它动 `scale`。 */
  readonly element: HTMLElement;
  /** 放大到这个倍数时，窗口宽度正好铺满视口。 */
  readonly maxScale: number;
  /** 视口 / 布局变化后重算几何与 `maxScale`。 */
  resize(): void;
  dispose(): void;
}

export interface WorkMaskOptions {
  /** `section.s-work`——用来把视口坐标换算成遮罩内坐标。 */
  readonly section: HTMLElement;
  /** `.s__ruler`——窗口的位置与尺寸来源。 */
  readonly ruler: HTMLElement;
}

export function createWorkMask(options: WorkMaskOptions): WorkMaskHandle {
  const { section, ruler } = options;

  const element = document.createElement('div');
  element.className = 's__mask';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('s__mask__svg');

  const pathOuter = document.createElementNS(SVG_NS, 'path');
  pathOuter.classList.add('s__mask__path-outer');
  const pathLines = document.createElementNS(SVG_NS, 'path');
  pathLines.classList.add('s__mask__path-lines');
  const pathInner = document.createElementNS(SVG_NS, 'path');
  pathInner.classList.add('s__mask__path-inner');

  // 顺序与参考站一致：内沿 → 外沿 → 参考线。
  //
  // SVG 子元素按**文档顺序**绘制（三条 path 都没有 z-index），后 append 的画在上层。
  // `path-inner` 是**不透明**的挖洞遮片（`fill: var(--color-primary)` + `fill-rule: evenodd`），
  // 必须垫在最底下，否则它会整片盖掉 `path-lines`（参考线网格）与 `path-outer` 的外沿描边，
  // 只把自己那条内唇线留在屏幕上——而且它带 `translate3d(0, sp*48px, 0)`，
  // 那条线会随滚动滑出胶囊，看起来就是「窗下伸出来一个碗」。
  // 反过来 `path-outer` 的不透明填充正好用来盖掉漂出窗外的内唇线：它挖掉的洞更大，
  // 洞口外（= 遮片上）的一切都被它抹平。
  svg.append(pathInner, pathOuter, pathLines);
  element.append(svg);

  let maxScale = 1;

  const resize = (): void => {
    const maskWidth = element.clientWidth || window.innerWidth;
    const maskHeight = element.clientHeight || window.innerHeight;
    svg.style.width = `${maskWidth}px`;
    svg.style.height = `${maskHeight}px`;

    const sectionRect = section.getBoundingClientRect();
    const rulerRect = ruler.getBoundingClientRect();
    const width = rulerRect.width;
    const height = rulerRect.height;

    // 还没布局（或已被移除）时不动几何，免得写出一堆 NaN。
    if (!(width > 0) || !(height > 0)) {
      maxScale = 1;
      return;
    }

    const left = rulerRect.left - sectionRect.left;
    const top = rulerRect.top - sectionRect.top;

    // 四角随内缩一起移动，所以包一层可复用的对象。
    const corners = {
      tl: { x: left, y: top },
      tr: { x: left + width, y: top },
      br: { x: left + width, y: top + height },
      bl: { x: left, y: top + height },
    };

    /** 上下半圆 + 左右直边——竖直胶囊。半径取当前窗宽的一半。 */
    const stadium = (radius: number): string =>
      `M ${corners.tl.x} ${corners.tl.y + radius} ` +
      `A ${radius} ${radius} 0 0 1 ${corners.tr.x} ${corners.tr.y + radius} ` +
      `L ${corners.br.x} ${corners.br.y - radius} ` +
      `A ${radius} ${radius} 0 0 1 ${corners.bl.x} ${corners.bl.y - radius} Z`;

    // 整屏矩形：比遮罩再往外各留 1px，避免缩放后边缘露出缝。
    const frame = `M -1 0 L ${maskWidth + 2} 0 L ${maskWidth + 2} ${maskHeight} L -1 ${maskHeight} Z`;

    let radius = (corners.tr.x - corners.tl.x) / 2;
    maxScale = window.innerWidth / radius;

    const outerWindow = stadium(radius);
    // 环 = 整屏 - 窗口；evenodd 让中间的窗口真的空掉。
    const ring = `${frame} ${outerWindow}`;
    pathOuter.setAttribute('d', ring);

    // 内唇：同样的胶囊，四角各向内收 LIP。
    const lip = window.innerWidth > COMPACT_MAX_WIDTH ? LIP_DESKTOP : LIP_COMPACT;
    corners.tl.x += lip;
    corners.tl.y += lip;
    corners.tr.x -= lip;
    corners.tr.y += lip;
    corners.br.x -= lip;
    corners.br.y -= lip;
    corners.bl.x += lip;
    corners.bl.y += lip;
    radius = (corners.tr.x - corners.tl.x) / 2;
    pathInner.setAttribute('d', `${frame} ${stadium(radius)}`);

    // 参考线网格：12 条竖线 + 每 10% 高一条横线。
    const columns = window.innerWidth > COMPACT_MAX_WIDTH ? V_LINES_DESKTOP : V_LINES_COMPACT;
    const gapX = maskWidth / columns;
    const gapY = maskHeight * H_LINE_RATIO;
    const rows = Math.ceil(maskHeight / gapY);

    let lines = '';
    // 竖线从第 2 条画到倒数第 2 条（第 1 条与整屏边重合，不画）。
    for (let column = 1; column < columns; column += 1) {
      const x = gapX * column;
      lines += `M ${x} 0 L ${x} ${maskHeight} `;
    }
    for (let row = 0; row < rows; row += 1) {
      const y = gapY * row;
      lines += `M 0 ${y} L ${maskWidth} ${y} `;
    }
    pathLines.setAttribute('d', lines);
    // 用整屏-窗口的环去裁，参考线只留在遮片上（浏览器原生 path() 裁剪）。
    pathLines.style.clipPath = `path(evenodd, '${ring}')`;
  };

  resize();

  return {
    element,
    get maxScale() {
      return maxScale;
    },
    resize,
    dispose: () => {
      element.remove();
    },
  };
}
