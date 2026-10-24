/**
 * 一张作品卡——参考站 `<a-work class="s__scene__work s__scene__work--video js-work">`
 * 的移植。本站统一是 `createXxx(): XxxHandle` 范式，不注册自定义元素（HMR 下会重复
 * 注册抛错、也没必要为一张卡上自定义元素）。
 *
 * 结构（与参考站逐字一致）：
 *
 *   .s__scene__work.a-work            ← 被 CSS 用 `--progress / --y / --size` 变换
 *     .a__inner
 *       a（无 href 时退化成 div）
 *         .a__video | .a__img         ← **媒体自己决定卡片尺寸**
 *         .a__caption
 *           .a__caption__text         作品名
 *           .a__caption__key          #agen-0000/34
 *
 * **没有 `.a__media` 包裹层**（参考站也没有）。`.a__video` 的 CSS 是
 * `width:auto; max-width:50vw; height:auto; max-height:50vh`——卡片多宽完全由媒体的
 * 固有尺寸（参考站是 `<video width="1082" height="636">`）在这两个上限里缩放决定。
 * 所以占位素材也必须是一张**有 1082×636 固有尺寸**的图，否则整张卡会塌成 0 宽。
 *
 * **`progress ∈ [-1, 1]`**：`1` 在右侧屏外、`0` 正中、`-1` 在左侧屏外——卡片是「横穿
 * 过去」，不是「飞进来停下」。
 */

import { workCaptionKey, type WorkCardContent } from '../content/works';

/** 卡片在 `progress` 的这两个边界外视为「不在场」：停视频、收起渲染。 */
const OUT_THRESHOLD = 0.9999;

/** 占位图的固有尺寸，对齐参考站 `<video width="1082" height="636">`。 */
const MEDIA_WIDTH = 1082;
const MEDIA_HEIGHT = 636;

/**
 * 由下标派生的确定性伪随机（0..1），用的是 mulberry32 的收尾函数。
 *
 * 参考站 `setWorks()` 用的是 `Math.random()`；这里换成确定性哈希，分布完全同形
 * （`--size` 均匀落在 [0.5, 1]、`--y` 均匀落在 ±[0.5, 1]），但**同样的输入永远渲染
 * 同样的构图**——截图回归才有可比性。这是相对参考站的一处有意偏差。
 *
 * 注意别用 `sin(seed * k)` 那种写法：相邻 seed 的差值一旦接近 2π 的整数倍，
 * 结果就会成串地挤在一起（实测下标 6/7 得到 0.752 / 0.762，「随机」直接失效）。
 * 下面这版雪崩性质良好。
 */
const hash01 = (seed: number): number => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 占位素材：一张 1082×636 的内联 SVG，色调由下标派生（同一张卡每次刷新都一样）。 */
const placeholderSrc = (index: number): string => {
  const hue = 138 + (index % 9) * 5;
  const label = String(index + 1).padStart(2, '0');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MEDIA_WIDTH}" height="${MEDIA_HEIGHT}" ` +
    `viewBox="0 0 ${MEDIA_WIDTH} ${MEDIA_HEIGHT}">` +
    `<defs>` +
    `<linearGradient id="b" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 30% 21%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue + 14} 34% 11%)"/>` +
    `</linearGradient>` +
    // 高光用径向渐变而不是实心圆：实心圆被卡片边界裁切后会留下一条硬边。
    `<radialGradient id="glow" cx="0.2" cy="0.12" r="0.95">` +
    `<stop offset="0" stop-color="hsl(${hue + 6} 32% 30%)" stop-opacity="0.6"/>` +
    `<stop offset="0.55" stop-color="hsl(${hue + 6} 32% 26%)" stop-opacity="0.18"/>` +
    `<stop offset="1" stop-color="hsl(${hue + 6} 32% 26%)" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${MEDIA_WIDTH}" height="${MEDIA_HEIGHT}" fill="url(#b)"/>` +
    `<rect width="${MEDIA_WIDTH}" height="${MEDIA_HEIGHT}" fill="url(#glow)"/>` +
    `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="ui-monospace, monospace" font-size="${MEDIA_HEIGHT * 0.42}" ` +
    `font-weight="700" fill="rgba(242,247,240,0.16)">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export interface WorkCardOptions {
  readonly content: WorkCardContent;
  /** 卡片下标，用来派生占位色调与散布参数。 */
  readonly index: number;
  /**
   * 墙上总张数（图注分母）。
   *
   * 首页接真实作品后张数不再是常量 34；缺省仍按 34，保证老调用与回归断言不变。
   */
  readonly total?: number;
}

export interface WorkCardHandle {
  /** `.s__scene__work.a-work` */
  readonly element: HTMLElement;
  /** 驱动卡片；`progress ∈ [-1, 1]`，`0` 表示正中。 */
  setProgress(progress: number): void;
  /** 当前是否「在场」（用于外部统计/调试）。 */
  isInView(): boolean;
  dispose(): void;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function createWorkCard(options: WorkCardOptions): WorkCardHandle {
  const { content, index } = options;

  const root = document.createElement('div');
  root.className = 's__scene__work a-work';

  // 参考站 `setWorks()`：`--size` 决定缩放（0.5~1），`--y` 决定垂直散开（偶上奇下）。
  root.style.setProperty('--size', (0.5 + hash01(index + 1) * 0.5).toFixed(4));
  root.style.setProperty(
    '--y',
    ((0.5 + hash01(index + 101) * 0.5) * (index % 2 ? -1 : 1)).toFixed(4),
  );

  const inner = document.createElement('div');
  inner.className = 'a__inner';

  const link = document.createElement(content.href ? 'a' : 'div');
  if (content.href) {
    link.setAttribute('href', content.href);
    link.classList.add('a__link');
    /*
     * 站内链接（`#works/<slug>`）必须同页跳转。
     *
     * 早期所有卡片都写死 `target="_blank"`，因为那时只有外链；现在首页的卡默认指向
     * 站内详情页，再开新标签会变成「点一次多一个标签」，而且新标签里的哈希路由要从
     * 头挂一遍。默认按地址判断，`external` 可以覆盖。
     */
    const external = content.external ?? !content.href.startsWith('#');
    if (external) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    }
  }

  let video: HTMLVideoElement | null = null;
  const src = content.src;
  const isVideo = content.media === 'video' || (content.media === undefined && src?.endsWith('.mp4'));

  if (src && isVideo) {
    video = document.createElement('video');
    video.className = 'a__video';
    // 参考站也是先写 data-src，等真正进场才赋给 src —— 34 张卡不能一起解码。
    video.dataset.src = src;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.width = MEDIA_WIDTH;
    video.height = MEDIA_HEIGHT;
    link.append(video);
  } else {
    // 有 src 就当真图，没有就用内联 SVG 占位图；两者都走 `.a__img` 的同一套约束，
    // 于是占位卡片和真卡片尺寸完全一致。
    const image = document.createElement('img');
    image.className = 'a__img';
    image.src = src ?? placeholderSrc(index);
    image.alt = content.title;
    image.width = MEDIA_WIDTH;
    image.height = MEDIA_HEIGHT;
    image.decoding = 'async';
    /*
     * 真实素材**不用** `loading="lazy"`。
     *
     * 卡片平时被 `translate3d` 推到右侧屏外，`lazy` 会等到它进入视口那一刻才开始下载——
     * 而它进视口到掠出屏幕只有零点几秒，结果就是「飞过去一张空白卡」。
     * 墙上最多 34 张，换成封面后总体积仍可控；空白卡是绝对不能接受的。
     */
    link.append(image);
  }

  const caption = document.createElement('div');
  caption.className = 'a__caption';
  const captionText = document.createElement('div');
  captionText.className = 'a__caption__text';
  captionText.textContent = content.title;
  const captionKey = document.createElement('div');
  captionKey.className = 'a__caption__key';
  captionKey.textContent = workCaptionKey(content, { total: options.total });
  caption.append(captionText, captionKey);

  link.append(caption);
  inner.append(link);
  root.append(inner);

  let inView = false;

  const startVideo = (): void => {
    if (!video) return;
    if (!video.src && video.dataset.src) {
      video.src = video.dataset.src;
      video.load();
    }
    void video.play().catch(() => undefined);
  };

  const setProgress = (progress: number): void => {
    const value = clamp(progress, -1, 1);
    root.style.setProperty('--progress', value.toFixed(4));

    // 只有真正在途中（-1 < p < 1）才渲染与播放；两端都算离场。
    // 参考站的 `attributeChangedCallback` 判的就是 `progress === "1" || progress === "-1"`。
    const nextInView = value > -OUT_THRESHOLD && value < OUT_THRESHOLD;
    if (nextInView === inView) return;
    inView = nextInView;

    root.classList.toggle('is-inview', nextInView);
    if (nextInView) startVideo();
    else video?.pause();
  };

  // 初始一律离场：时间轴建好之前不该有任何卡片露出来。
  root.classList.remove('is-inview');

  return {
    element: root,
    setProgress,
    isInView: () => inView,
    dispose: () => {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      root.remove();
    },
  };
}
