/**
 * Lenis 平滑滚动 + 与本站既有「滚动锁」的共存。
 *
 * 参考站用 Lenis 默认参数（`lerp: 0.1`）接管滚动，我们照抄；差别在于**本站前面的
 * 「我是谁 / 我会什么」两屏有滚动锁**：进入时给 `document.body` 加
 * `is-identity-locked` / `is-skills-locked`（等价于 `body { position: fixed;
 * overflow: hidden; top: -scrollY }`），并在解锁那一刻 `window.scrollTo(0, …)`。
 * 用户要求这两屏「不要动」，所以只能让 Lenis 去适配它们。
 *
 * 共存策略：
 *   1. **锁期间 `lenis.stop()`**。此时 Lenis 既不响应滚轮也不写滚动，唯一的滚动
 *      写入者是板块自己的 `window.scrollTo`，两者不会抢。
 *   2. **解锁瞬间重同步**。去掉类 → 清 `top` → `scrollTo` 三步是同步完成的；而
 *      `MutationObserver` 回调是微任务，会赶在**下一帧 rAF 之前**跑，那时
 *      `window.scrollY` 已是正确值。这时用 `immediate + force` 把 Lenis 内部值
 *      种回去再 `start()`，它下一帧就不会把页面拽回旧位置。
 *
 * 为什么用默认模式而不是 `wrapper`：Lenis 默认驱动的是真实 `scrollTop`（不是给
 * `html` 挂 `transform`），所以 `window.scrollY`、原生 `scroll` 事件、
 * `getBoundingClientRect()` 全部照常工作——hero 视差、导航折叠、前两屏的
 * `update()` 一行都不用改。换成 `wrapper` 会改变 `window.scrollY` 的语义，
 * 直接破坏全站既有的 rect 驱动逻辑。
 */

import Lenis from 'lenis';
import { gsap, ScrollTrigger } from './gsap-support';
import { prefersReducedMotion } from './text-support';

/** 与 `styles.css` 里 body 的两个锁类一一对应。 */
const LOCK_CLASSES = ['is-identity-locked', 'is-skills-locked'] as const;

/** 一次滚动的可选参数。 */
export interface SmoothScrollOptions {
  /**
   * 立刻落位、不做插值。
   *
   * 缺省按「给了 `duration` 就动画，没给就立即落位」推断——本站既有的调用
   * （DEV 探针、板块自己的定位）要的都是一步到位，而 2026-10 新增的
   * 「跳过 / 回到顶部」两个胶囊要的是「快但不瞬移」，它们显式传 `duration`。
   */
  immediate?: boolean;
  /**
   * 用「时长 + 缓动」推进，**覆盖 Lenis 默认的 `lerp` 指数逼近**。
   *
   * 为什么需要它：跨十几屏的长距离跳转用 `lerp: 0.1` 会拖成一条很久的尾巴
   * （指数逼近只在开始时快），换成 0.9~1.1 秒的定时长缓动才是「快速滑过去」。
   */
  duration?: number;
  easing?: (t: number) => number;
}

/**
 * 只暴露「滚到某处」这一件事的窄接口。
 *
 * 板块（`sections/works.ts` / `sections/cta.ts`）只依赖它——它们没有任何理由
 * 拿到 Lenis 实例去 `stop()` / `destroy()`，窄接口也省得在 jsdom 回归里造整个句柄。
 */
export interface ScrollToController {
  scrollTo(target: number, options?: SmoothScrollOptions): void;
}

export interface SmoothScrollHandle extends ScrollToController {
  /** 底层实例；`prefers-reduced-motion` 时为 `null`（退回原生滚动）。 */
  readonly lenis: Lenis | null;
  /** 布局变化后重算 Lenis 与 ScrollTrigger 的尺寸。 */
  refresh(): void;
  dispose(): void;
}

const isLocked = (): boolean => LOCK_CLASSES.some((name) => document.body.classList.contains(name));

export function initSmoothScroll(): SmoothScrollHandle {
  // 减少动态时完全不接管滚动：原生滚动没有惯性延迟，更符合「减少动态」的预期。
  // 也因此**忽略 `duration`**——胶囊按钮传进来的时长式滚动在这里退化成一步到位，
  // 这正是 reduced-motion 想要的（跳过去，但不滑）。
  if (prefersReducedMotion() || typeof window === 'undefined') {
    return {
      lenis: null,
      scrollTo: (target) => window.scrollTo(0, target),
      refresh: () => ScrollTrigger.refresh(),
      dispose: () => {},
    };
  }

  const lenis = new Lenis({ autoRaf: false, lerp: 0.1 });
  lenis.on('scroll', ScrollTrigger.update);

  const tick = (time: number): void => {
    lenis.raf(time * 1000);
  };
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  let stopped = false;

  /** 按 body 的锁类决定停/起，并在解锁时把 Lenis 的内部位置对齐到真实滚动位置。 */
  const sync = (): void => {
    const locked = isLocked();
    if (locked && !stopped) {
      stopped = true;
      lenis.stop();
      return;
    }
    if (!locked && stopped) {
      // 退出锁定：前两屏此时已经把页面 scrollTo 回原位，直接跟上即可。
      stopped = false;
      lenis.scrollTo(window.scrollY, { immediate: true, force: true });
      lenis.start();
    }
  };

  // 锁类由前两屏在 rAF 回调里同步加上，微任务早于下一帧，所以 Lenis 会在它动手前被停。
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();

  return {
    lenis,
    scrollTo: (target, options) =>
      lenis.scrollTo(target, {
        // 默认值按「有没有要求动画」推断，见 `SmoothScrollOptions.immediate`。
        immediate: options?.immediate ?? options?.duration === undefined,
        duration: options?.duration,
        easing: options?.easing,
        // `force`：即使 Lenis 当前被滚动锁 `stop()` 也照做（锁只在最前面两屏出现）。
        force: true,
      }),
    refresh: () => {
      lenis.resize();
      ScrollTrigger.refresh();
    },
    dispose: () => {
      observer.disconnect();
      gsap.ticker.remove(tick);
      lenis.destroy();
    },
  };
}
