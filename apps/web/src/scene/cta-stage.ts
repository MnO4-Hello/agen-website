/**
 * 「Let's Rock」圆盘——参考站 `class bc`（`hoisted.js` 里 `querySelector('.s-cta')` 那个）的移植。
 *
 * 结构（逐字对齐参考站）：
 *
 *   section.s-cta
 *     .s__inner.js-container#contact        ← 视口高一屏，圆盘就居中在它里面
 *       .s__hover.js-hover                  ← 悬停目标（尺寸 = 里面那颗 6rem 的按钮）
 *         .s__button.js-button > .s__button__inner > .s__button__text    ← "GO"
 *         .s__cta.js-cta                    ← 绝对定位的圆盘，clip-path 从 0 张开
 *           .s__cta__line--top / --bottom   ← 同一个圆心，各被裁掉一半
 *           a.s__cta__link                  ← 展开后才浮出来的邮箱
 *           .s__cta__stars > 4× svg.s__cta__star
 *           .a-dots
 *     .s__grid.js-grid                      ← 覆盖**整个** `.s-cta`（含 55rem 上留白）
 *       svg.s__grid__svg > path.s__grid__path
 *
 * **两个「盒子」不是同一个，这是最容易抄错的地方**：`.s__grid` 铺满整个 `.s-cta`
 * （含那 55rem 留白），而 `.js-container` 是视口高的 `.s__inner`。参考站里
 * 横向线数用 grid 的高、**纵向线间距却用 container 的高**（÷8），圆心则要换算到
 * grid 坐标系（`gridH - innerH / 2`）。照抄，别"顺手统一"。
 *
 * **`tick` 是定步长推进，不是 delta 驱动**：`progress += speed`，与帧间隔无关。
 * 也**不要**在 `state === 'paused'` 时跳过重画——参考站每帧照样 `movePoints` +
 * `drawLines`，靠把 tick 从总线上摘掉来实现"离屏不画"。
 *
 * 与参考站的三处必要差异（都只关系到"怎么接进来"，不关系到观感）：
 *   ① 参考站用全局事件总线 `$` 和 `[data-intersect]` 全局 observer；本站全站都是
 *      「各段自己挂 `IntersectionObserver` + `gsap.ticker`」（见 `a-separator.ts` /
 *      `work-stage.ts`），这里照本站的纪律内联。
 *   ② 参考站读 `window.safeWidth/safeHeight`（它全局缓存了 innerWidth/innerHeight）；
 *      本站没有这两个全局量，直接读 `innerWidth/innerHeight`。
 *   ③ 参考站 `init()` 挂在 `siteLoaded` / `readyState === 'complete'` 上；本站的工厂
 *      在 `root.append(shell)` **之前**就跑完了（那时 rect 全是 0），所以改由上层
 *      `sections/cta.ts` 在挂载后调 `layout()`。
 *   —— 另外参考站的点对象里有 `ax/ay` 两个字段，全程没人读，这里不搬。
 */

import type { CtaGlyph } from '../content/cta';
import { gsap } from './gsap-support';
import { measureLineShiftEm, prefersReducedMotion } from './text-support';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 每个字叠几层切片（参考站 DOM 里就是 4 层）。 */
const SLICE_COUNT = 4;

/** 竖向网格线数：宽屏 12 / 窄屏 8（参考站按 `window.safeWidth > 767` 分档）。 */
const V_LINES_WIDE = 12;
const V_LINES_NARROW = 8;

/** 上面那个分档的断点。 */
const NARROW_MAX_WIDTH = 767;

/** 横向线间距 = `.s__inner` 高度的 1/8（**不是** `.s__grid` 的）。 */
const H_DIVISIONS = 8;

/** `--size = min(inner.w, inner.h) - 32`，直接决定圆盘直径。 */
const SIZE_INSET = 32;

/** 涟漪：带宽，以及宽/窄屏两档推进速度与强度。 */
const RIPPLE_BAND = 30;
const RIPPLE_FREQUENCY = 0.01;
const SPEED_WIDE = 15;
const SPEED_NARROW = 10;
const STRENGTH_WIDE = 1;
const STRENGTH_NARROW = 0.35;

/** 悬停满 600ms 后，涟漪由「脉冲」升级成「冲击」。 */
const SHOCK_DELAY = 600;
const SHOCK_SPEED = 30;
const SHOCK_STRENGTH = 5;

/** 星形占位（参考站 49×49 的四角星）。 */
const STAR_PATH = 'm24.5 0 3.3 21.2L49 24.5l-21.2 3.3L24.5 49l-3.3-21.2L0 24.5l21.2-3.3L24.5 0z';

export interface CtaStageOptions {
  /** 圆盘上半行（只露字的上半）。 */
  readonly top: readonly CtaGlyph[];
  /** 圆盘下半行（只露字的下半）。 */
  readonly bottom: readonly CtaGlyph[];
  /** 中心按钮文字。 */
  readonly buttonLabel: string;
  /** 展开后那枚链接的邮箱。 */
  readonly email: string;
  /** `section` 的无障碍名字。 */
  readonly label: string;
}

export interface CtaStageHandle {
  /** `section.s-cta`。 */
  readonly element: HTMLElement;
  /** 进入/离开视口时挂上或摘掉逐帧回调（离屏后网格不再重画）。 */
  setActive(active: boolean): void;
  /**
   * 直接摆出/收起「已展开」态。
   *
   * 正常路径上展开完全由 `.s__hover` 的 hover 驱动；这个口子给两类旁路用：
   * `prefers-reduced-motion` 的静态终态，以及 DEV 冻帧截图（`?ctareveal=1`）。
   * 它同时把涟漪的 `op` 拍到位，并立刻重画一次网格——因为此时 ticker 通常没在跑。
   */
  reveal(active: boolean): void;
  /** 挂载后必须调一次：量尺寸、铺网格、建脉冲时间轴（此时才有真实布局）。 */
  layout(): void;
  /** 视口变化后重量尺寸并重铺网格。 */
  resize(): void;
  dispose(): void;
}

/**
 * 一个网格点。
 *
 * 字段沿用参考站的短名，因为它们之间的耦合很难用更长的名字说清楚：
 * `vx/vy` 是受力积分出的速度，`wx/wy` 是它的二级弹簧，`mx/my` 是最终生效的偏移，
 * `ox/oy` 是与涟漪 `progress` 相乘的那一份（真正的"波"）。
 */
interface GridPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
  wx: number;
  wy: number;
  mx: number;
  my: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  dist: number;
}

type WaveState = 'paused' | 'pulse' | 'shock';

/** 只要宽高——不引 `DOMRect`，省得在非浏览器环境（jsdom / 单测）里再多一个全局依赖。 */
interface Rect {
  width: number;
  height: number;
}

const EMPTY_RECT: Rect = { width: 0, height: 0 };

const isNarrow = (): boolean => window.innerWidth <= NARROW_MAX_WIDTH;

const createPoint = (x: number, y: number): GridPoint => ({
  x,
  y,
  vx: 0,
  vy: 0,
  wx: 0,
  wy: 0,
  mx: 0,
  my: 0,
  ox: 0,
  oy: 0,
  dx: 0,
  dy: 0,
  dist: 0,
});

const createStar = (): SVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 's__cta__star');
  svg.setAttribute('width', '49');
  svg.setAttribute('height', '49');
  svg.setAttribute('viewBox', '0 0 49 49');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', STAR_PATH);
  svg.append(path);
  return svg;
};

export function createCtaStage(options: CtaStageOptions): CtaStageHandle {
  const reduced = prefersReducedMotion();

  // —— DOM ——
  const section = document.createElement('section');
  section.className = 's-cta';
  section.setAttribute('aria-label', options.label);

  const container = document.createElement('div');
  container.className = 's__inner js-container';
  container.id = 'contact';

  const hover = document.createElement('div');
  hover.className = 's__hover js-hover';

  const button = document.createElement('div');
  button.className = 's__button js-button';
  const buttonInner = document.createElement('div');
  buttonInner.className = 's__button__inner';
  const buttonText = document.createElement('div');
  buttonText.className = 's__button__text js-button-text';
  buttonText.textContent = options.buttonLabel;
  buttonInner.append(buttonText);
  button.append(buttonInner);

  const cta = document.createElement('div');
  cta.className = 's__cta js-cta';

  // 两行大字共用同一套构造：每个字形一个 `.s__cta__char`，里面叠 SLICE_COUNT 层同样的切片。
  // CSS 负责让第 2~4 层错开一点点并交替闪 —— 那是"被切碎的字在抖"的来源。
  const buildLine = (glyphs: readonly CtaGlyph[], variant: 'top' | 'bottom'): HTMLElement => {
    const line = document.createElement('div');
    line.className = `s__cta__line s__cta__line--${variant}`;

    const text = document.createElement('div');
    text.className = 's__cta__text';

    for (const glyph of glyphs) {
      const char = document.createElement('span');
      char.className = 's__cta__char';

      for (let slice = 0; slice < SLICE_COUNT; slice += 1) {
        const piece = document.createElement('span');
        piece.className = 's__cta__char__slice';
        if (glyph.sup) {
          // 撇号是贴在字形右上角的上标，不占独立字符位（否则 4 字阶梯会被打乱）。
          const sup = document.createElement('span');
          sup.className = 'sup';
          sup.textContent = glyph.sup;
          piece.append(sup);
        }
        if (glyph.char) piece.prepend(document.createTextNode(glyph.char));
        char.append(piece);
      }

      text.append(char);
    }

    line.append(text);
    return line;
  };

  // 两行都要留引用：中缝校正（`applyLineShifts`）得往各自身上写 `--line-shift`。
  const lineTop = buildLine(options.top, 'top');
  const lineBottom = buildLine(options.bottom, 'bottom');

  const link = document.createElement('a');
  link.className = 's__cta__link';
  link.href = `mailto:${options.email}`;
  link.textContent = options.email;

  const stars = document.createElement('div');
  stars.className = 's__cta__stars';
  for (let index = 0; index < 4; index += 1) stars.append(createStar());

  const dots = document.createElement('div');
  dots.className = 'a-dots';

  cta.append(lineTop, lineBottom, link, stars, dots);

  hover.append(button, cta);
  container.append(hover);

  const grid = document.createElement('div');
  grid.className = 's__grid js-grid';
  const gridSvg = document.createElementNS(SVG_NS, 'svg');
  gridSvg.setAttribute('class', 's__grid__svg js-grid-svg');
  const gridPath = document.createElementNS(SVG_NS, 'path');
  gridPath.setAttribute('class', 's__grid__path js-grid-path');
  gridPath.setAttribute('d', '');
  gridSvg.append(gridPath);
  grid.append(gridSvg);

  section.append(container, grid);

  // —— 状态 ——
  const wave = {
    progress: 0,
    op: 0,
    speed: isNarrow() ? SPEED_NARROW : SPEED_WIDE,
    strength: isNarrow() ? STRENGTH_NARROW : STRENGTH_WIDE,
    state: 'paused' as WaveState,
    timeout: 0,
  };

  /** `.s__grid` 的盒子——铺满整个 `.s-cta`（含 55rem 上留白）。 */
  let gridRect: Rect = EMPTY_RECT;
  /** `.s__inner` 的盒子——视口高一屏，圆盘的居中基准。 */
  let innerRect: Rect = EMPTY_RECT;
  let ctaMaxSize = 0;

  let vLines = 0;
  let hLines = 0;
  let gapX = 0;
  let gapY = 0;
  /** 逐列存点：`points[列][行]`。画竖线按列顺读，画横线按行跨列读。 */
  const points: GridPoint[][] = [];

  let buttonIsHovered = false;
  let active = false;
  let laidOut = false;
  let timeline: gsap.core.Timeline | null = null;

  // —— 尺寸 ——
  const setSize = (): void => {
    gridRect = grid.getBoundingClientRect();
    innerRect = container.getBoundingClientRect();
    ctaMaxSize = Math.min(innerRect.width, innerRect.height) - SIZE_INSET;
    cta.style.setProperty('--size', `${ctaMaxSize}px`);
  };

  /** 一行的可见文字（上标不参与度量）。 */
  const lineText = (glyphs: readonly CtaGlyph[]): string =>
    glyphs.map((glyph) => glyph.char).join('');

  /**
   * 把两行各自的**墨迹中心**平移到中缝上（中缝 = 盒的几何中心，见 `styles.css` 里
   * 「两行大字」那段：字形在盒里是顶对齐的，若不校正，上行只露 cap 顶部、下行连底部
   * 一起露，两半根本不平分）。
   *
   * 为什么是运行时量而不是写死常量：上行是汉字，走的是**系统** CJK 回退字体
   * （Archivo Narrow 的 `unicode-range` 不含 CJK），垂直度量逐机不同。这里让 canvas
   * 用元素**自己算出来的 font-family 列表**去量，量的是浏览器真正会渲染的那套字体。
   *
   * 量不出来（jsdom 没有 2D 上下文 / 旧浏览器没有 `fontBoundingBox*`）就什么都不写，
   * `styles.css` 里 `--line-shift` 的静态兜底继续生效——所以这条路径对回归测试是透明的。
   */
  const applyLineShifts = (): void => {
    const computed = getComputedStyle(cta);
    const lines: readonly (readonly [HTMLElement, string])[] = [
      [lineTop, lineText(options.top)],
      [lineBottom, lineText(options.bottom)],
    ];
    for (const [line, text] of lines) {
      if (!text) continue;
      const shift = measureLineShiftEm({
        fontFamily: computed.fontFamily,
        weight: computed.fontWeight,
        text,
        // 与 styles.css 对得上：`.s__cta__text { height: .8em }` + `.s__cta { line-height: 1 }`。
        boxHeightEm: 0.8,
        lineHeightEm: 1,
      });
      if (shift === null) continue;
      line.style.setProperty('--line-shift', `${shift.toFixed(4)}em`);
    }
  };

  // —— 网格 ——
  const setGrid = (): void => {
    const width = gridRect.width;
    const height = gridRect.height;

    gridSvg.style.width = `${width}px`;
    gridSvg.style.height = `${height}px`;
    points.length = 0;

    vLines = isNarrow() ? V_LINES_NARROW : V_LINES_WIDE;
    gapX = width / vLines;
    // 注意：这一行的分母是 container 的高，不是 grid 的高（参考站如此）。
    gapY = innerRect.height / H_DIVISIONS;
    hLines = Math.floor(height / gapY);

    // 除不尽的余高从第 2 行起平摊下去，免得最后一行贴不到段底。
    const remainder = height - gapY * hLines;
    const centerX = width / 2;
    // 圆心：`.s__inner` 在 grid 坐标系里的中心（inner 是整段最底下那一屏）。
    const centerY = height - innerRect.height / 2;

    for (let column = 0; column <= vLines; column += 1) {
      const line: GridPoint[] = [];
      for (let row = 0; row <= hLines; row += 1) {
        const point = createPoint(gapX * column, gapY * row + (row !== 0 ? remainder : 0));
        const offsetX = point.x - centerX;
        const offsetY = point.y - centerY;
        const angle = Math.atan2(offsetY, offsetX);
        point.dist = Math.hypot(offsetX, offsetY);
        if (point.dist === 0) {
          point.dx = 0;
          point.dy = 0;
        } else {
          // 从圆心朝外的单位方向 × (grid 半宽 / 距离) × 5
          point.dx = Math.cos(angle) * ((width / 2) / point.dist) * 5;
          point.dy = Math.sin(angle) * ((width / 2) / point.dist) * 5;
        }
        line.push(point);
      }
      points.push(line);
    }
  };

  // —— 涟漪 ——
  const easeOut = (value: number): number =>
    value === 1 ? 1 : 1 - Math.pow(2, -10 * value);

  const movePoints = (): void => {
    const diagonal = Math.hypot(window.innerHeight, window.innerWidth);

    for (const line of points) {
      for (let row = 0; row < line.length; row += 1) {
        const point = line[row];
        // 第 0 行贴在段顶，不参与涟漪（参考站 `o === 0` 就 return）。
        if (row === 0 || point.dist === 0) continue;

        const distance = Math.abs(point.dist - wave.progress);
        if (distance < RIPPLE_BAND) {
          const falloff = 1 - distance / RIPPLE_BAND;
          const angle = Math.atan2(point.dy, point.dx);
          const push = Math.cos(distance * RIPPLE_FREQUENCY) * falloff;
          point.vx += Math.cos(angle) * push * RIPPLE_BAND * 0.5 * wave.strength;
          point.vy += Math.sin(angle) * push * RIPPLE_BAND * 0.5 * wave.strength;
        }

        point.vx += (0 - point.wx) * 0.001;
        point.vy += (0 - point.wy) * 0.001;
        point.vx *= 0.9;
        point.vy *= 0.9;
        point.wx += point.vx * 3;
        point.wy += point.vy * 3;
        point.wx *= 0.9;
        point.wy *= 0.9;
        point.mx = point.wx * 0.1;
        point.my = point.wy * 0.1;

        // 这一份才是"波"：算一次就冻住，最后乘以 wave.op 淡入淡出。
        point.ox = easeOut(point.dx / diagonal) * gapX * 75 * (point.dist / ctaMaxSize);
        point.oy = easeOut(point.dy / diagonal) * gapY * 75 * (point.dist / ctaMaxSize);
      }
    }
  };

  const movedPoint = (point: GridPoint): { x: number; y: number } => ({
    x: point.x + point.mx + point.ox * wave.op,
    y: point.y + point.my + point.oy * wave.op,
  });

  const drawLines = (): void => {
    let d = '';

    // 竖线：每列一条折线
    for (const line of points) {
      for (let row = 0; row < line.length; row += 1) {
        const moved = movedPoint(line[row]);
        d += row === 0 ? `M ${moved.x} ${moved.y} ` : `L ${moved.x} ${moved.y} `;
      }
    }

    // 横线：每个行号一条折线，跨过所有列
    for (let row = 0; row < hLines; row += 1) {
      for (let column = 0; column < points.length; column += 1) {
        const moved = movedPoint(points[column][row]);
        d += column === 0 ? `M ${moved.x} ${moved.y} ` : `L ${moved.x} ${moved.y} `;
      }
    }

    gridPath.setAttribute('d', d);
  };

  const wavePulse = (): void => {
    // 悬停期间不再自动发起脉冲，免得和冲击打架。
    if (buttonIsHovered) return;
    wave.progress = 0;
    wave.state = 'pulse';
    wave.speed = isNarrow() ? SPEED_NARROW : SPEED_WIDE;
    wave.strength = isNarrow() ? STRENGTH_NARROW : STRENGTH_WIDE;
  };

  const waveShock = (): void => {
    if (!buttonIsHovered || wave.state === 'shock') return;
    wave.progress = 0;
    wave.state = 'shock';
    wave.speed = SHOCK_SPEED;
    wave.strength = SHOCK_STRENGTH;
  };

  const buildTimeline = (): void => {
    if (timeline) return;
    // 「GO」一直在呼吸：0.85 → 1.05 慢进，然后飞快弹回，循环之间停 0.5s。
    // 每次循环收尾时把涟漪重新播一遍（参考站就是靠这条 call 驱动脉冲的）。
    timeline = gsap.timeline({ repeat: -1, repeatDelay: 0.5 });
    timeline.call(() => {
      wave.state = 'pulse';
    });
    timeline.fromTo(
      buttonText,
      { scale: 0.85 },
      { scale: 1.05, duration: 2.7, ease: 'power2.in' },
    );
    timeline.call(wavePulse);
    timeline.to(buttonText, { scale: 0.85, duration: 0.15, ease: 'power4.out' });
  };

  const fadeWave = (op: number, duration: number, delay = 0): void => {
    if (reduced) {
      wave.op = op;
      return;
    }
    gsap.to(wave, { op, delay, duration, ease: 'expo.inOut', overwrite: true });
  };

  // —— 每帧 ——
  const tick = (): void => {
    // 还没量过尺寸就什么都不画：那时 `ctaMaxSize` 是 0，`movePoints` 会算出 NaN，
    // 写进 `d` 会让整条 path 变成无效值。挂载后 `layout()` 一跑，下一帧自然接上。
    if (!laidOut) return;
    if (wave.progress < gridRect.height && wave.state !== 'paused') wave.progress += wave.speed;
    movePoints();
    drawLines();
  };

  /**
   * 涟漪的"总开关"。参考站由 `$.on('tick')` / `$.off('tick')` 摘挂回调实现，
   * 这里等价地挂/摘 ticker；`prefers-reduced-motion` 下根本不挂。
   *
   * 声明在 `tick` 之后是刻意的：`const` binding 在它之前处于 TDZ，虽然只有调用时才解引用、
   * 运行期其实不会炸，但把顺序摆对能省掉一次"这里真的安全吗"的心算。
   */
  const setActive = (value: boolean): void => {
    if (reduced || value === active) return;
    active = value;
    if (active) gsap.ticker.add(tick);
    else gsap.ticker.remove(tick);
  };

  // —— 交互 ——
  const onHover = (event: Event): void => {
    if (buttonIsHovered) return;
    buttonIsHovered = true;
    hover.classList.add('is-active');
    timeline?.pause();
    window.clearTimeout(wave.timeout);
    wave.timeout = window.setTimeout(waveShock, SHOCK_DELAY);
    fadeWave(1, 1.2, 0.3);
    event.stopPropagation();
  };

  const onOut = (event: Event): void => {
    // 触摸路径：参考站在 touchstart 命中链接时直接跳转（`<span class="sup">` 之类
    // 子元素会让 `tagName` 不是 A，所以这里用 `closest`）。
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (anchor instanceof HTMLAnchorElement && anchor.href) {
      window.location.href = anchor.href;
      return;
    }

    if (!buttonIsHovered) return;
    window.clearTimeout(wave.timeout);
    buttonIsHovered = false;
    hover.classList.remove('is-active');
    timeline?.play(0);
    fadeWave(0, 0.7);
  };

  const controller = new AbortController();
  const { signal } = controller;
  hover.addEventListener('mouseenter', onHover, { signal });
  hover.addEventListener('touchstart', onHover, { signal, passive: true });
  hover.addEventListener('mouseleave', onOut, { signal, passive: true });
  section.addEventListener('touchstart', onOut, { signal, passive: true });

  // 只在视口内跑涟漪。参考站用全局的 `[data-intersect]` observer，我们在这里挂一个。
  // 参考站还会顺带加 `is-out-of-view-top/bottom`，但 `.s-cta` 的 CSS 只用得到
  // `is-out-of-view`（唯一消费点：把 `.s__hover` 藏掉），所以那两个不搬。
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            const inView = Boolean(entry?.isIntersecting);
            section.classList.toggle('is-in-view', inView);
            section.classList.toggle('is-out-of-view', !inView);
            setActive(inView);
          },
          { threshold: 0 },
        );
  observer?.observe(section);

  return {
    element: section,

    setActive,

    reveal: (value) => {
      hover.classList.toggle('is-active', value);
      fadeWave(value ? 1 : 0, 0);
      // 此时 ticker 多半没在跑，不主动画一次的话网格会停在旧几何（甚至是空 d）。
      drawLines();
    },

    layout: () => {
      setSize();
      // 中缝校正排在 setSize 之后：`--size` 决定字号，而量出来的位移是 em（随字号缩放）。
      // 字体落位后 `sections/cta.ts` 会再调一次 layout()，那一趟才量到真正的 CJK 回退字体。
      applyLineShifts();
      setGrid();
      if (!reduced) buildTimeline();
      drawLines();
      laidOut = true;
    },

    resize: () => {
      // 还没挂载时量出来全是 0，铺出来的网格会退化成一条线。
      if (!laidOut) return;
      setSize();
      applyLineShifts();
      setGrid();
      drawLines();
    },

    dispose: () => {
      controller.abort();
      observer?.disconnect();
      window.clearTimeout(wave.timeout);
      gsap.ticker.remove(tick);
      gsap.killTweensOf(wave);
      timeline?.kill();
      timeline = null;
      active = false;
      section.remove();
    },
  };
}
