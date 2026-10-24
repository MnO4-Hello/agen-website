/**
 * 二进制分隔带——逐字移植参考站（wodniack.dev）的 `<a-separator>`。
 *
 * 结构（照抄参考站）：
 *   .a-separator
 *     .a__triangle                       ← 左侧实心三角，绝对定位
 *     .a__binaries
 *       ×4: .a__code（15 个 .a__char） + .a__stripes
 *     .a__triangle                       ← 右侧实心三角
 *
 * 每个 `.a__char` 是一个 `overflow: hidden` 的窗口；它的 `::before` 里放字符串
 * `"01"` 并 `word-break: break-all`，于是 `0` 与 `1` 竖向堆叠——`translate: 0` 露
 * `0`，`translate: 0 -100%` 露 `1`。**每帧每个字符有 10% 概率随机翻转**（参考站
 * `Cc.tick()` 的做法），所以静止时这条带子也在持续抖动。
 *
 * 与参考站的差异只有一处：斜杠条纹的文本用 `attr(data-stripes)` 注入而不是写死在
 * CSS 的 `content` 里——CSS 里塞 300 多个斜杠太难维护，DOM 与视觉效果完全一致。
 */

import { gsap } from '../scene/gsap-support';

/** 每帧每个字符翻转的概率（参考站 `Math.random() > .1` 即 10%）。 */
const FLIP_CHANCE = 0.1;

/** 斜杠条纹的重复次数（参考站 CSS 里那串约 350 个斜杠）。 */
const STRIPE_COUNT = 300;

export interface SeparatorOptions {
  /** 每组二进制的字符数。参考站 15。 */
  readonly groupSize?: number;
  /** 组数。参考站 4。 */
  readonly groups?: number;
  /** 附加类名，例如 `'style--secondary'`。 */
  readonly className?: string;
}

export interface SeparatorHandle {
  readonly element: HTMLElement;
  /** 进入/离开视口时由外部调用；离场后不再抖动（省 CPU）。 */
  setActive(active: boolean): void;
  dispose(): void;
}

export function createSeparator(options: SeparatorOptions = {}): SeparatorHandle {
  const groupSize = options.groupSize ?? 15;
  const groups = options.groups ?? 4;

  const element = document.createElement('div');
  element.className = 'a-separator';
  if (options.className) element.classList.add(options.className);

  const binaries = document.createElement('span');
  binaries.className = 'a__binaries';

  const chars: HTMLElement[] = [];

  for (let group = 0; group < groups; group += 1) {
    const code = document.createElement('span');
    code.className = 'a__code';

    for (let index = 0; index < groupSize; index += 1) {
      const char = document.createElement('span');
      // 初始每颗随机落在 0 或 1，进场时就不是一条整齐的带子。
      char.className = `a__char a__char--${Math.random() > 0.5 ? '1' : '0'}`;
      chars.push(char);
      code.append(char);
    }

    const stripes = document.createElement('span');
    stripes.className = 'a__stripes';
    stripes.dataset.stripes = '/'.repeat(STRIPE_COUNT);

    binaries.append(code, stripes);
  }

  const leftTriangle = document.createElement('span');
  leftTriangle.className = 'a__triangle';
  const rightTriangle = document.createElement('span');
  rightTriangle.className = 'a__triangle';

  element.append(leftTriangle, binaries, rightTriangle);

  let active = false;

  const tick = (): void => {
    if (!active) return;
    for (const char of chars) {
      if (Math.random() > FLIP_CHANCE) continue;
      const next = Math.random() > 0.5 ? '0' : '1';
      char.classList.toggle('a__char--0', next === '0');
      char.classList.toggle('a__char--1', next === '1');
    }
  };

  gsap.ticker.add(tick);

  // 只在视口内抖动。参考站用全局的 `[data-intersect]` observer，我们直接在这里挂一个。
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            active = Boolean(entry?.isIntersecting);
          },
          { threshold: 0 },
        );
  observer?.observe(element);

  return {
    element,
    setActive: (value) => {
      active = value;
    },
    dispose: () => {
      observer?.disconnect();
      gsap.ticker.remove(tick);
      element.remove();
    },
  };
}
