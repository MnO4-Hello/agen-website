/**
 * 首屏与导航栏的滚动节奏。
 *
 * 关键在于：首屏内容**不再自己往下跑**。以前的版本让字标边下沉边向前倾，
 * 结果是下滑的时候字标反而比周围元素走得慢，和下面的板块叠在一起。现在改成
 * “字标跟着页面正常往上走”，只保留一点倾斜和淡出；真正把首屏送出视野的是页面
 * 滚动本身（配合 `.hero-exit` 那段过渡空间）。
 *
 * 做法仍然是一个滚动量算一次，把结果写成根节点上的 CSS 变量，具体形变留给
 * 样式表；p 在前 `RANGE` 像素内由 0 走到 1：
 *
 *   - 字标原地轻微前倾、稍微收小，并随滚动淡出；
 *   - 导航栏的面板淡掉，品牌和菜单缩进各自的上角变成小药丸。
 *
 * 这里读的是 `effectiveScrollY()` 而不是 `window.scrollY`：下面的“我是谁？”板块
 * 把页面钉住播放时会冻结滚动，直接读 `window.scrollY` 会把导航栏误判成回到顶部。
 */

import { effectiveScrollY } from '../scroll-lock';

export interface HeroParallaxHandle {
  /** 移除监听。 */
  dispose(): void;
}

/** 完成整段过渡所需的滚动距离（px）。 */
const RANGE = 300;
const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;
const ease = (progress: number): number => 1 - Math.pow(1 - progress, 2);
const fixed = (value: number, digits = 3): string => value.toFixed(digits);

export function attachHeroParallax(): HeroParallaxHandle {
  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>('.site-header');

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { dispose: () => {} };
  }

  let frame = 0;
  let lastScroll = -1;
  let lastCollapsed: boolean | null = null;

  const update = (): void => {
    frame = 0;
    // 读“真实滚动量”：identity 把页面钉住播放时 `window.scrollY` 会被归零，直接
    // 读它会让收成胶囊的导航栏又铺开。
    const scroll = effectiveScrollY();
    if (scroll === lastScroll) return;
    lastScroll = scroll;

    // 量化一下，避免亚像素抖动引起每帧重绘。
    const eased = ease(Math.min(scroll, RANGE) / RANGE);
    const p = Math.round(eased * 1000) / 1000;

    // 字标：跟着页面一起往上走（这里不再设 translateY），只做轻微的前倾和
    // 淡出，视觉上像一张被翻起来的卡片。
    root.style.setProperty('--hero-tilt', `${fixed(lerp(6, 34, p), 2)}deg`);
    root.style.setProperty('--hero-scale', fixed(lerp(1, 0.94, p)));
    root.style.setProperty('--hero-fade', fixed(lerp(1, 0.1, p)));
    // 背后的模糊副本下沉得更多一点，两层才有纵深。
    root.style.setProperty('--hero-depth', `${fixed(lerp(16, 40, p), 1)}px`);

    // 导航栏面板：0.5 之后开始消失，`fade` 是“消失量”。
    const fade = Math.max(0, (p - 0.5) / 0.5);
    root.style.setProperty('--header-opacity', fixed(1 - fade));

    // 品牌 / 菜单：缩小并收进各自的上角。
    root.style.setProperty('--brand-scale', fixed(lerp(1, 0.66, p)));
    root.style.setProperty('--brand-shift-x', `${fixed(lerp(0, -8, p), 1)}px`);
    root.style.setProperty('--brand-shift-y', `${fixed(lerp(0, -10, p), 1)}px`);
    root.style.setProperty('--nav-scale', fixed(lerp(1, 0.8, p)));
    root.style.setProperty('--nav-shift-x', `${fixed(lerp(0, 8, p), 1)}px`);
    root.style.setProperty('--nav-shift-y', `${fixed(lerp(0, -10, p), 1)}px`);

    const collapsed = p > 0.62;
    if (header && collapsed !== lastCollapsed) {
      header.classList.toggle('is-collapsed', collapsed);
      lastCollapsed = collapsed;
    }
  };

  const onScroll = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(update);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  update();

  return {
    dispose: () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    },
  };
}
