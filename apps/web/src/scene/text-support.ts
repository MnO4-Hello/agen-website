/**
 * Small helpers shared by the identity section's particle effects.
 */

/**
 * Resolves once the web fonts (and therefore the glyph metrics) are ready, so
 * text is never measured or laid out against a fallback face. Resolves
 * immediately when nothing is pending or when the API is unavailable.
 */
export async function whenFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best-effort; laying out with the fallback face still works.
  }
}

/**
 * 截图用的强制开关：置为 true 之后 `prefersReducedMotion()` 恒为真。
 *
 * 为什么需要它：`identity` / `skills` 两个板块的入场动画一旦开始就会**冻结 body 滚动**，
 * 而 headless 的 `--screenshot` 只抓文档前一个视口高度的内容、也不能滚动——于是这两屏
 * 根本拍不到「动画播完」的样子。它们的 `reduced` 分支本就等于「直接落到终态」，
 * 于是截图时用 `?rm=1` 把这个开关打开，走同一条已经存在的静态路径。
 *
 * 只在 `main.ts` 的 DEV 分支里调用过，生产构建里没有任何代码会调它。
 */
let forcedReducedMotion = false;

/** DEV 截图专用：强制走「减少动态」分支。必须在视图创建之前调用。 */
export function forceReducedMotion(): void {
  forcedReducedMotion = true;
}

/**
 * True when the viewport asks for reduced motion. Callers use this to skip the
 * animation entirely rather than merely shortening it.
 */
export function prefersReducedMotion(): boolean {
  if (forcedReducedMotion) return true;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `measureLineShiftEm()` 的入参。 */
export interface LineMetricsOptions {
  /**
   * 已解析的 font-family **列表**。
   *
   * 刻意不传单个字体名：直接把元素的计算值喂给 canvas，浏览器才会在这一处也走
   * 同一套回退链（汉字落到系统 CJK 字体这件事，只有它自己最清楚）。
   */
  readonly fontFamily: string;
  /** `font-weight` 的计算值。 */
  readonly weight: string;
  /** 该行的可见文字。 */
  readonly text: string;
  /** 行盒高度（em），即 `.s__cta__text` 的 `height`。 */
  readonly boxHeightEm: number;
  /** 行高（em），即继承下来的 `line-height`。 */
  readonly lineHeightEm: number;
}

/**
 * 量出「这一行文字的墨迹中心」相对行盒顶边的偏移，返回**把它挪到盒几何中心所需的
 * 位移**（em，正 = 向下）。量不出来时返回 `null`。
 *
 * 为什么必须运行时量、不能写死常量：CTA 圆盘那两行共用一条中缝（= 盒的几何中心），
 * 而字形在盒里是**顶对齐**的，墨迹中心落在哪完全取决于字体的垂直度量与 cap /
 * ideographic 高度。下行是自己托管的 Archivo Narrow（度量固定），上行却是汉字——
 * Archivo 的 `unicode-range` 只覆盖 latin，汉字会落到**系统**中文字体
 * （Microsoft YaHei / PingFang SC / Noto Sans SC…），每台机器的度量都不一样。
 * 写死常量只能对一台机器准，而这一屏恰恰是「看起来有没有对齐」一眼就穿帮的地方。
 *
 * 数学与 DOM 同源（`styles.css` 里 GO 按钮那个 `line-height` 用的是同一套）：
 * 单行块的基线 = `(lineHeight − (ascent + descent)) / 2 + ascent`；
 * 再用 canvas 的 `actualBoundingBoxAscent/Descent` 取真实墨迹的上下沿，取中点即可。
 *
 * `null` 的两种情况：jsdom 没有 2D 上下文（回归测试因此天然走 CSS 兜底），
 * 或浏览器没实现 `fontBoundingBox*`（旧 Safari）——那时退回静态常量，不会算错。
 */
export function measureLineShiftEm(options: LineMetricsOptions): number | null {
  if (typeof document === 'undefined') return null;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;

  // 用一个方便换算的参考字号；结果最后要除以它才回到 em。
  const reference = 100;
  context.font = `${options.weight} ${reference}px ${options.fontFamily}`;
  const metrics = context.measureText(options.text);
  const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = metrics;
  const { actualBoundingBoxAscent: inkAscent, actualBoundingBoxDescent: inkDescent } = metrics;
  if (![ascent, descent, inkAscent, inkDescent].every((value) => Number.isFinite(value))) {
    return null;
  }

  const baseline = ((options.lineHeightEm - (ascent + descent) / reference) / 2 + ascent / reference) * reference;
  const inkCentre = baseline + (inkDescent - inkAscent) / 2;
  const shift = ((options.boxHeightEm / 2) * reference - inkCentre) / reference;
  return Number.isFinite(shift) ? shift : null;
}
