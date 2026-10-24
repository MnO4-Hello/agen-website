/**
 * 「Let's Rock」CTA + 页脚的装配层——参考站页面最后两块（`section.s-cta` → `footer.site-foot`）。
 *
 * 只负责把两块拼起来、接上视口/尺寸/字体时序，动效全在 `scene/cta-stage.ts`。
 *
 *   section.s-cta   ← 圆盘 + 涟漪网格（`scene/cta-stage.ts`）
 *   footer.site-foot ← 一颗「回到顶部」胶囊（静止写「回到顶部」，悬停变「阿根」）。
 *                      参考站这里是它的 AW 几何字标；本站 2026-10 把它换成了按钮形式
 *                      ——页脚是长页面的最底端，「能点回去」比「再放一遍品牌图形」有用。
 *
 * 参考站这两块是 `.site-wrapper` 下的兄弟节点，这里也保持同级——但挂在 `.app-shell` 下，
 * 和 `.works` 平级。**没有** `a-separator`：参考站 `s-my-way` 与 `s-cta` 之间也没有
 * （最后一个 `<a-separator>` 在 `s-my-way` **之前**）。
 *
 * 与 `works.ts` 一样，`createCtaSection()` 是在 `root.append(shell)` **之前**跑完的，
 * 那一刻 rect 全是 0，所以尺寸必须在挂载后重量一次。
 */

import {
  CTA_BUTTON_LABEL,
  CTA_EMAIL,
  CTA_HEADLINE_BOTTOM,
  CTA_HEADLINE_TOP,
  CTA_SECTION_LABEL,
  FOOTER_MARK_LABEL,
  FOOTER_PILL_LABEL,
} from '../content/cta';
import { createCtaStage, type CtaStageHandle } from '../scene/cta-stage';
import type { ScrollToController } from '../scene/smooth-scroll';

export interface CtaSectionOptions {
  /**
   * 平滑滚动入口（由 `main.ts` 注入 Lenis 句柄）。
   *
   * 只有页脚那颗「回到顶部」胶囊用得到；缺省时回落到原生
   * `window.scrollTo({ behavior: 'smooth' })`（jsdom 回归里就是这条）。
   */
  readonly scrollTo?: ScrollToController['scrollTo'];
}

export interface CtaSectionHandle {
  /** `section.s-cta` */
  readonly element: HTMLElement;
  /** `footer.site-foot` */
  readonly footer: HTMLElement;
  layout(): void;
  resize(): void;
  dispose(): void;
}

/* —— 布局的统一入口 ——
   identity / skills 的滚动锁会把 body 冻成 `position: fixed`、`overflow: hidden`
   （见 styles.css 顶部），文档高度随之被压塌，这时量出来的一切尺寸都是错的。
   本段虽然在后半页、理论上早解锁了，但 `fonts.ready` / `load` / `resize` 这几个
   触发点不保证锁已经放开，所以沿用 `works.ts` 那套「锁着就挂起、解锁再补做」的守卫。 */
const LOCK_CLASSES = ['is-identity-locked', 'is-skills-locked'] as const;
const isPageLocked = (): boolean =>
  LOCK_CLASSES.some((name) => document.body.classList.contains(name));

/**
 * 页脚：一颗「回到顶部」胶囊。
 *
 *   footer.site-foot
 *     a.site-foot__capsule[href="#home"]      ← 无障碍名字用「阿根」，因为那是它的品牌身份；
 *       span.site-foot__capsule-rest          ← 静止态文案：「回到顶部」（功能先讲清楚）
 *       span.site-foot__capsule-hover         ← 悬停态文案：「阿根」
 *
 * 两个 span 由 CSS 叠在同一格里交叉淡入淡出（见 styles.css 的页脚区块），**不写 JS 状态**——
 * 纯 `:hover` / `:focus-visible` 就能表达，键盘用户也拿得到同一份反馈。
 */
const createFooter = (options: CtaSectionOptions): HTMLElement => {
  const footer = document.createElement('footer');
  footer.className = 'site-foot';

  const capsule = document.createElement('a');
  capsule.className = 'site-foot__capsule';
  capsule.href = '#home';
  capsule.setAttribute('aria-label', `${FOOTER_MARK_LABEL}，回到页面顶部`);
  capsule.addEventListener('click', (event) => {
    event.preventDefault();
    if (options.scrollTo) {
      // 跨整页的长距离：给定时长（而不是 Lenis 默认的 `lerp` 指数逼近）才干脆。
      options.scrollTo(0, { duration: 1.1, easing: (t) => 1 - (1 - t) ** 3 });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const rest = document.createElement('span');
  rest.className = 'site-foot__capsule-rest';
  rest.textContent = FOOTER_PILL_LABEL;

  const hover = document.createElement('span');
  hover.className = 'site-foot__capsule-hover';
  hover.textContent = FOOTER_MARK_LABEL;

  capsule.append(rest, hover);
  footer.append(capsule);
  return footer;
};

export function createCtaSection(options: CtaSectionOptions = {}): CtaSectionHandle {
  const stage: CtaStageHandle = createCtaStage({
    top: CTA_HEADLINE_TOP,
    bottom: CTA_HEADLINE_BOTTOM,
    buttonLabel: CTA_BUTTON_LABEL,
    email: CTA_EMAIL,
    label: CTA_SECTION_LABEL,
  });
  const footer = createFooter(options);
  const element = stage.element;

  let unlockObserver: MutationObserver | null = null;
  let pendingLayout: (() => void) | null = null;
  const deferUntilUnlocked = (action: () => void): void => {
    pendingLayout = action;
    if (unlockObserver) return;
    unlockObserver = new MutationObserver(() => {
      if (isPageLocked()) return;
      unlockObserver?.disconnect();
      unlockObserver = null;
      const next = pendingLayout;
      pendingLayout = null;
      next?.();
    });
    unlockObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  };

  const runLayout = (): void => {
    if (isPageLocked()) {
      deferUntilUnlocked(runLayout);
      return;
    }
    stage.layout();
  };

  let resizeFrame = 0;
  const onResize = (): void => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (isPageLocked()) {
        deferUntilUnlocked(() => stage.resize());
        return;
      }
      stage.resize();
    });
  };
  window.addEventListener('resize', onResize);

  // 挂载后过一帧再量：工厂跑在 append 之前，那时整棵子树还没有布局。
  let layoutFrame = 0;
  const scheduleLayout = (): void => {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!element.isConnected) {
        scheduleLayout();
        return;
      }
      runLayout();
    });
  };
  scheduleLayout();

  // 字体落位后字宽才算准——「LET'S / ROCK」要按 `--size` 的比例去量，必须重量一次。
  if (document.fonts) void document.fonts.ready.then(runLayout).catch(() => undefined);
  window.addEventListener('load', runLayout, { once: true });

  /* —— DEV 探针（仅 DEV；生产构建整段被 DCE 掉）——
     参考站这一屏的像素基准拿不到（它的字体 Bigger Display 是商用字，本机也没有它的
     截图通道），所以字体校准只能自洽校验：把 `--size` 与两行大字量出来的宽度回传，
     看两行的比值是否落在目标区间。文本通道依旧走 sendBeacon → .workbuddy/tmp/sink.mjs。

       ?cta=1        进入截图模式：只显示 .s-cta 与 .site-foot，并关掉动画/过渡
       ?ctareveal=1  直接摆出「已展开」态（圆盘张开 + 邮箱浮出）
       ?probe=1      左上角叠一块读数，并 beacon 回本机
       ?sink=<port>  诊断汇端口（默认 9099） */
  const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
  const shotMode = devParams?.get('cta') === '1';
  const revealMode = shotMode && devParams?.get('ctareveal') === '1';
  const probeMode = devParams?.get('probe') === '1';

  /**
   * 截图模式：把 CTA 之前的板块整块拿掉，并**中和掉那 55rem 上留白**。
   *
   * 拿掉前序板块的理由和 `works.ts` 完全一样：hero / identity / skills 各自有一套
   * 自动播放的开场（进视口就自己锁滚动、自己 scrollTo），跟截图定位是纯竞态。
   *
   * 中和留白是本段特有的：`.s-cta` 顶上那 55rem 是给 `s-my-way` 的下留白做衔接的，
   * 在 `scrollY = 0` 下会把整个圆盘推到视口之外——而 `--headless --screenshot` 只能
   * 截文档的**前 windowHeight 行**。留白归零只影响网格的覆盖范围，不影响 `--size`
   * （它只认 `.s__inner` 的矩形），所以字体校准依然有效。
   */
  const installShotStyles = (): void => {
    const style = document.createElement('style');
    style.id = '__cta-shot';
    style.textContent = [
      'html.is-cta-shot .app-shell > *{display:none !important;}',
      'html.is-cta-shot .app-shell > .s-cta{display:block !important;padding-top:0 !important;}',
      'html.is-cta-shot .app-shell > .site-foot{display:flex !important;}',
      // 视口门控在截图模式下不可靠（observer 回调与抓帧同帧竞争），直接钉死。
      'html.is-cta-shot .s-cta .s__hover{display:block !important;}',
      // `will-change` 会把元素提成独立合成层，而截图取的是最近一次已提交的合成帧；
      // 去掉提升 + 关掉 transition/animation，才是「拨到哪一帧就是哪一帧」。
      'html.is-cta-shot *,html.is-cta-shot{will-change:auto !important;}',
      'html.is-cta-shot *,html.is-cta-shot *::before,html.is-cta-shot *::after{' +
        'transition:none !important;animation:none !important;}',
    ].join('\n');
    document.head.append(style);
    document.documentElement.classList.add('is-cta-shot');
  };

  const beacon = (payload: Record<string, unknown>): void => {
    try {
      const port = devParams?.get('sink') ?? '9099';
      navigator.sendBeacon(`http://127.0.0.1:${port}/probe`, JSON.stringify(payload));
    } catch {
      /* 没开 sink 时静默——这本就是可选的调试通道 */
    }
  };

  /** 字体校准的判据：`--size` 与两行大字实测宽度、以及各自占 `--size` 的比例。 */
  const metrics = (): Record<string, unknown> => {
    // `--size` 是 JS 写在 `.s__cta` **行内**的（不是 `.s-cta`）——自定义属性只向下继承，
    // 所以必须从 `.s__cta` 自己身上读，问父元素只会拿到空串。
    const cta = element.querySelector<HTMLElement>('.s__cta');
    const size = parseFloat(
      cta ? getComputedStyle(cta).getPropertyValue('--size') : '0',
    );
    const ratio = size > 0 ? size : 1;
    const lineWidth = (variant: 'top' | 'bottom'): number =>
      element
        .querySelector<HTMLElement>(`.s__cta__line--${variant} .s__cta__text`)
        ?.getBoundingClientRect().width ?? 0;
    const top = lineWidth('top');
    const bottom = lineWidth('bottom');
    /**
     * 中缝校正量（`--line-shift`）。
     *
     * 它是**运行时**由 canvas 墨迹度量算出来的（见 `text-support.ts` 的
     * `measureLineShiftEm`），所以只有把它打出来才能确认「这一趟测量到底跑没跑、
     * 跑出来是多少」——读行内样式，没量到就是 `(unset)`（那时用的是 CSS 静态兜底）。
     */
    const lineShift = (variant: 'top' | 'bottom'): string =>
      element
        .querySelector<HTMLElement>(`.s__cta__line--${variant}`)
        ?.style.getPropertyValue('--line-shift')
        .trim() || '(unset)';
    return {
      size: Math.round(size),
      top: Math.round(top),
      bottom: Math.round(bottom),
      topRatio: Number((top / ratio).toFixed(3)),
      bottomRatio: Number((bottom / ratio).toFixed(3)),
      shiftTop: lineShift('top'),
      shiftBottom: lineShift('bottom'),
      balance: Number((bottom / (top || 1)).toFixed(3)),
      font: cta ? getComputedStyle(cta).fontFamily : '(缺 .s__cta)',
      sectionHeight: Math.round(element.getBoundingClientRect().height),
      innerHeight: Math.round(
        element.querySelector<HTMLElement>('.s__inner')?.getBoundingClientRect().height ?? 0,
      ),
      gridPathLength: element.querySelector('.s__grid__path')?.getAttribute('d')?.length ?? 0,
    };
  };

  const mountProbe = (): void => {
    // 幂等：`applyShotState()` 会跑两次（立刻 + 字体就绪后），面板只能有一块。
    const existing = document.getElementById('__cta-probe');
    if (existing) {
      existing.remove();
    }
    const panel = document.createElement('pre');
    panel.id = '__cta-probe';
    panel.style.cssText =
      'position:fixed;top:0;left:0;z-index:9999;margin:0;padding:.5rem .75rem;' +
      'background:#fff;color:#000;font:12px/1.5 ui-monospace,Consolas,monospace;' +
      'pointer-events:none;white-space:pre;';
    document.body.append(panel);
    const draw = (): void => {
      const data = metrics();
      panel.textContent = Object.entries(data)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join('\n');
      beacon(data);
    };
    // 立刻画一次：`--headless --screenshot` 在 load 附近就抓帧，等字体/定时器
    // 可能已经晚了。后面两次是重算（字体落位后字宽才会变）。
    draw();
    if (document.fonts) void document.fonts.ready.then(draw).catch(() => undefined);
    window.setTimeout(draw, 400);
  };

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__ctaDebug = {
      layout: () => stage.layout(),
      reveal: (value: boolean) => stage.reveal(value),
      setActive: (value: boolean) => stage.setActive(value),
      metrics,
    };
  }

  if (shotMode) {
    installShotStyles();
    // 字体落位后再拨状态：字宽/`--size` 都要等它。
    const applyShotState = (): void => {
      stage.layout();
      if (revealMode) stage.reveal(true);
      if (probeMode) mountProbe();
    };
    if (document.fonts) {
      void document.fonts.ready.then(applyShotState).catch(() => undefined);
    }
    applyShotState();
  }

  return {
    element,
    footer,
    layout: runLayout,
    resize: onResize,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('load', runLayout);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      unlockObserver?.disconnect();
      pendingLayout = null;
      document.getElementById('__cta-shot')?.remove();
      document.getElementById('__cta-probe')?.remove();
      document.documentElement.classList.remove('is-cta-shot');
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__ctaDebug;
      stage.dispose();
      footer.remove();
    },
  };
}
