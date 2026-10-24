/**
 * 「作品」板块的装配层。
 *
 * 只负责把几块拼起来、接上视口门控与 resize，具体动效都在各自的 scene / component 里：
 *
 *   a-separator  →  section.s-work（34 张卡的钉住舞台）  →  a-separator  →  section.s-my-way
 *
 * 参考站里这几块是分开的 `<section>`，`a-separator` 夹在段落之间；这里保持一致。
 * **前面一条和后面一条都必须是 `style--secondary`**——参考站的静态 HTML 就是这样
 * （见 `.workbuddy/tmp/ref.html`：`</section><!-- .s-work -->` 后面紧跟着
 * `<a-separator data-intersect class="style--secondary">`，然后是 `<section class="s-my-way">`）。
 *
 * 三段各自的驱动方式不同，别混淆：
 *   - `a-separator`：自跑（GSAP ticker + 自己的 IntersectionObserver）；
 *   - `s-work`：一条 ScrollTrigger 时间轴（`scrub: 1`）；
 *   - `s-my-way`：自跑物理（GSAP ticker + 指针事件），只用 `--scroll-progress` 做位移。
 */

import { createSeparator } from '../components/a-separator';
import {
  WORK_SKIP_HINT,
  WORK_SKIP_LABEL,
  WORKS_SECTION_LABEL,
  WORKS_TITLE,
  WORK_CARDS,
  type WorkCardContent,
} from '../content/works';
import { gsap, ScrollTrigger } from '../scene/gsap-support';
import { createMyWay, type MyWayHandle } from '../scene/my-way';
import type { ScrollToController } from '../scene/smooth-scroll';
import { prefersReducedMotion } from '../scene/text-support';
import { createWorkStage, type WorkStageHandle } from '../scene/work-stage';

export interface WorksSectionOptions {
  /**
   * 平滑滚动入口（由 `main.ts` 注入 Lenis 句柄）。
   *
   * 缺省时「跳过」退化成 `window.scrollTo` 一步到位——jsdom 回归里就是这么跑的，
   * 也保证这个 section 单独挂载时不崩。
   */
  readonly scrollTo?: ScrollToController['scrollTo'];
  /**
   * 作品墙的数据源（首页注入 `fetchWorks().then(toWallCards)`）。
   *
   * 为什么是 Promise 而不是在这里自己 fetch：
   *   · jsdom 回归里没有 fetch 桩，不传就完全走「34 张占位卡」的老路径；
   *   · `devShotMode`（`?wp=` / `?probe=` / `?live=`）必须跳过它——截图基准图的
   *     `--height` 与卡数必须是确定的 34 / 1700lvh，不能随库里有多少作品而变。
   */
  readonly cardsPromise?: Promise<readonly WorkCardContent[]>;
}

export interface WorksSectionHandle {
  readonly element: HTMLElement;
  /**
   * 重新量一次尺寸并重建（遮罩几何 / 幽灵阵列 / 时间轴）。
   *
   * 正常路径上这一步由挂载后的 rAF 与 `resize` 自动完成；显式暴露出来是为了
   * **结构回归测试**能确定性地在挂载之后立刻量一次，而不必赌 rAF 时序
   * （见 .workbuddy/tmp/dom-test.mjs）。
   */
  layout(): void;
  /**
   * 把时间轴拨到指定进度并立即渲染。
   *
   * 这**不是**给业务用的接口：生产路径上进度完全由滚动经 ScrollTrigger 驱动，
   * 外部拨动会在下一帧被 scrub 覆盖。它的用途是让截图脚本与回归测试能把时间轴
   * 停在确定的帧上（配合 `WorkStageHandle.setFreeze`）。
   */
  setProgress(progress: number): void;
  /** 当前时间轴进度（与 `setProgress` 同属测试通道）。 */
  progress(): number;
  dispose(): void;
}

export function createWorksSection(options: WorksSectionOptions = {}): WorksSectionHandle {
  const root = document.createElement('div');
  root.className = 'works';
  root.setAttribute('aria-label', WORKS_SECTION_LABEL);

  const separator = createSeparator({ className: 'style--secondary' });
  // 收尾那条：参考站在 `.s-work` 与 `.s-my-way` 之间也夹了一条同样样式的分隔带。
  // 少了它，`.s-work` 的 1700lvh 行程会**直接**贴到 `.s-my-way` 的 `clip-path` 上，
  // 交接处没有那条「印刷栅格」过渡，看起来像两块拼贴硬切。
  const separatorOutro = createSeparator({ className: 'style--secondary' });
  const stage: WorkStageHandle = createWorkStage({ cards: WORK_CARDS, title: WORKS_TITLE });
  const outro: MyWayHandle = createMyWay();

  root.append(separator.element, stage.element, separatorOutro.element, outro.element);

  /* —— 「跳过」胶囊 ——
     进本段时浮在视口右下角，一键落到 WORK 时间轴**走完那一帧**（遮罩合拢、WORK 四字
     收回框内）。理由很实在：本段是 34 张卡 × 50lvh = 1700lvh 的行程，认真滑过去很熬人。

     挂 `stage.element`（`section.s-work`）上、**不要**放进 `.s__outer`——后者带
     `clip-path: inset(0 -1rem)`，会把 `position: fixed` 的后代一起裁掉（那样按钮只在
     `.s__outer` 的纵向范围内可见）。`.s-work` 自己只有 `position: relative`，
     没有 transform，所以 fixed 的包含块仍是视口，按钮不会被钉住的舞台带走。

     reduced-motion 下**照样建**：本段的高度不变、行程一样长，缺了它反而更难受；
     那时注入的 `scrollTo` 是「一步到位」的原生桩（见 smooth-scroll.ts），不会滑动。

     唯一的层级副作用：`.s-work` 自己带 `z-index: 4`，于是它会把本按钮的 `z-index: 20`
     关在这个层叠上下文里——只有 `.leaf-canvas`(5) 与 `.site-header`(30) 比它高，
     也就是说飘落的枫叶可能从胶囊**上面**掠过。这是全站一致的既有分层（枫叶本来就压在
     所有板块内容之上，包括 CTA 圆盘与页脚），而且那张画布是 `pointer-events: none`，
     点击照常落到按钮上；为了一枚按钮去动 `.s-work` 那条刻意抬到 4 的层叠不值得。 */
  const skipButton = document.createElement('button');
  skipButton.type = 'button';
  skipButton.className = 'work__skip';
  skipButton.textContent = WORK_SKIP_LABEL;
  skipButton.setAttribute('aria-label', WORK_SKIP_HINT);
  stage.element.append(skipButton);

  /** 本段是否处在「时间轴区间内」（与下面那条 ScrollTrigger 的 isActive 同步）。 */
  let skipVisible = false;
  /** 点过之后收起；等本段整个离开区间才复位，所以滚回本段还能再跳一次。 */
  let skipDismissed = false;
  /** 视图已经拆掉。异步回调（作品数据）靠它判断「要不要还去动 DOM」。 */
  let disposed = false;
  const syncSkip = (): void => {
    skipButton.classList.toggle('is-visible', skipVisible && !skipDismissed);
  };

  /**
   * 显隐直接沿用**与时间轴同一条区间**（`start: 'top 25%'` / `end: 'bottom 75%'`）。
   *
   * 为什么不自建 IntersectionObserver + rAF 节流：那是三十行、而且每次都要
   * `getBoundingClientRect()`（强制同步布局，本段对这条纪律很敏感——见 work-stage 的
   * `tick`）；ScrollTrigger 本来就在同一区间上随滚动更新，让它顺手回一个 `isActive`
   * 既省又准，区间定义也就只有一处、不会跟时间轴走偏。
   */
  const skipTrigger = ScrollTrigger.create({
    trigger: stage.element,
    start: 'top 25%',
    end: 'bottom 75%',
    onToggle: (self) => {
      skipVisible = self.isActive;
      if (!skipVisible) skipDismissed = false;
      syncSkip();
    },
  });

  skipButton.addEventListener('click', () => {
    const rect = stage.element.getBoundingClientRect();
    // 时间轴 progress = 1 那一帧：ScrollTrigger 的 `end` 就是「section 底边抵到视口 75% 处」。
    // 用 `rect.top + scrollY` 而不是 `offsetTop`——后者的 offsetParent 是 `.works`，不含它的偏移。
    const endY = rect.top + window.scrollY + rect.height - 0.75 * window.innerHeight;
    // 先收起再滚：跨十几屏的滚动要滑近一秒，按钮留在画面上会显得没人理它。
    skipDismissed = true;
    syncSkip();
    if (options.scrollTo) {
      options.scrollTo(endY, { duration: 0.9, easing: (t) => 1 - (1 - t) ** 3 });
      return;
    }
    window.scrollTo(0, endY);
  });

  // 结尾区块只在视口里跑物理与自动甩出。
  const outroObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            outro.setActive(Boolean(entries[entries.length - 1]?.isIntersecting));
          },
          { threshold: 0 },
        );
  outroObserver?.observe(outro.element);

  // 参考站会在结尾整块离开视口下方时把它 `display:none`，这里用类名等价表达。
  const outroEdgeObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            const below = entry.boundingClientRect.top > window.innerHeight;
            outro.element.classList.toggle('is-out-of-view-bottom', below);
          },
          { threshold: 0 },
        );
  outroEdgeObserver?.observe(outro.element);

  const reduced = prefersReducedMotion();

  if (reduced) {
    root.classList.add('is-reduced');
    separator.setActive(true);
    separatorOutro.setActive(true);
  }

  /* —— 布局的统一入口 ——
     identity / skills 的滚动锁会把 body 冻成 `position: fixed`、`overflow: hidden`
     （见 styles.css 顶部），文档高度随之被压塌，这时量出来的一切尺寸都是错的。
     而 `document.fonts.ready` / `load` / `resize` 这三个触发点，都有可能在这把锁还没
     放下来的时候才到——若直接 refresh，ScrollTrigger 会按压塌后的高度重算，反过来
     轻推正在播放的锁定屏。所以：锁着就把动作挂起，等解锁再补做一次。 */
  const LOCK_CLASSES = ['is-identity-locked', 'is-skills-locked'] as const;
  const isPageLocked = (): boolean => LOCK_CLASSES.some((name) => document.body.classList.contains(name));

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

  /* —— 截图模式的 URL 状态钩子（仅 DEV；生产构建整段被 DCE 掉） ——
     这台机器上 Edge 的两条 DevTools 通道都不可用：
       · `--remote-debugging-port`：Edge 确实在 127.0.0.1 上 LISTENING（netstat 可见），
         但本机存在系统级、按进程/端口选择性丢弃回环 SYN 的行为，curl 一律 000；
       · `--remote-debugging-pipe`：Edge 的启动器会立刻 exit(0)，真正的浏览器进程脱离，
         fd 3 / fd 4 传不过去，一条 CDP 响应都收不到。
     唯一还通的通道是 `--headless --screenshot`，而它只能「加载 URL → 截屏」，没法在加载
     之后注入滚动。所以把「滚到哪、时间轴拨到哪」编码进 URL，让页面自己在初始化末尾落到
     那个状态——没有滚动时序竞态，反而比 CDP 驱动更确定。

       ?wp=0.25       时间轴进度
       ?woffset=0.04  滚到本段高度的百分之几处（默认 0.04）
       ?probe=1       左上角叠一块指标读数，让截图自身携带数字 */
  const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
  const devShotMode = Boolean(devParams && (devParams.has('wp') || devParams.has('probe') || devParams.has('live')));

  /**
   * `?live=<progress>` → 目标进度；非空时走「真实滚动」路径而不是冻帧。
   * 两者互斥：live 要的正是 ScrollTrigger 还活着。
   */
  const liveParam = devParams?.get('live') ?? null;
  const liveTarget = liveParam === null ? null : Number(liveParam);
  const useLive = liveTarget !== null && Number.isFinite(liveTarget);

  /**
   * `?sp=<值>`（−1 … +1）：把 `--scroll-progress` 钉在指定值再截图。
   *
   * 这个钩子不是锦上添花，是**必需的**：`?wp=` 恒在 `scrollY = 0` 下拍，而本段从文档
   * 顶部开始 ⇒ `rect.top = 0`、`rect.bottom ≫ 视口` ⇒ 三段式算出来**恰好是 0**。
   * 于是「钉住期间到底漂不漂」这一层，冻帧截图**永远拍不到**——这次漏掉的两个缺陷里
   * 有一个正藏在该层（`.s__inner` / `path-inner` / `.s__canvas` 三层视差）。有了 `?sp=`
   * 才能把 −1 / 0 / +1 三档摆出来逐一比对。
   * 与 `?live=` 互斥：live 走真实滚动，它的意义就是「别钉住」。
   */
  const spParam = devParams?.get('sp') ?? null;
  if (devShotMode && !useLive && spParam !== null && Number.isFinite(Number(spParam))) {
    stage.setScrollProgressOverride(Number(spParam));
  }

  /**
   * 截图模式下要装的三条样式 + 一个根类名。
   *
   * ① 让 body 的滚动锁在 CSS 上失效。前两屏的 `applyLock()` 每帧都会把锁类加回来，所以
   *    「定期摘类」是 race、时灵时不灵（早先实测只能滚到 40px）。让类留着、但不再
   *    `position: fixed` 压塌文档，前两屏仍以为自己锁着，不会反复把我们 scrollTo 回去。
   *
   * ② 把 WORK 之前的所有板块整块 `display:none`。这一步是必需的，不是为了好看：
   *    hero / identity / skills 三块各自有一套**自动播放**的开场（进视口就自己锁滚动、
   *    自己 `scrollTo`），它们和截图脚本的定位是纯竞态——实测页面最终会被它们拽到一个
   *    什么都没画的位置（截出来 100% 是浏览器的空白底色 #fcfcfc）。整块拿掉之后：
   *    · 本段直接从文档顶部开始，不滚动就能进画面；
   *    · 前两屏一 `display:none`，它们的 IntersectionObserver 就永不触发，开场与滚动锁
   *      根本不会启动（这里一行都没动 identity.ts / skills.ts）。
   *
   * ③ 关掉 `will-change` 与所有 transition/animation。
   *
   *    这一条同样是**为了正确**、不是洁癖。`.s__mask` / `.s__scene` / `.s__inner` 都带
   *    `will-change: transform|scale`，会被提升成独立合成层；而 `--headless --screenshot`
   *    取的是**最近一次已提交的合成帧**。结果是：探针（读的是行内样式与
   *    `getBoundingClientRect`）明明报 `tf=matrix(12,…)`、`mask` 盒子 16992×9132，
   *    像素画的却是 scale(1) 的那一帧——遮罩张开的动作整段丢失，截图上永远停在开场。
   *    去掉图层提升后元素回到父层随父层一起光栅化，连同 transition 一起冻结，截图才等
   *    于「拨到哪一帧就是哪一帧」。
   */
  const installShotStyles = (): void => {
    const style = document.createElement('style');
    style.id = '__shot-mode';
    style.textContent = [
      'body.is-identity-locked,body.is-skills-locked{position:static !important;' +
        'overflow:visible !important;top:auto !important;left:auto !important;' +
        'right:auto !important;width:auto !important;}',
      'html.is-shot-mode .app-shell > *{display:none !important;}',
      'html.is-shot-mode .app-shell > .works{display:block !important;}',
      // 「跳过」胶囊挂在 `.s-work` 里，上面那条 display:block 会把 `.works` 放回来，
      // 于是它也会跟着进画面——截图基准要的是纯舞台，单独摘掉。
      // `?skip=1` 例外：它就是为了拍那颗胶囊才留的（fixed 元素只有在 `scrollY = 0`
      // 且本段从文档顶部开始时才落得进截图，所以必须配 `?wp=` 一起用）。
      devParams?.get('skip') === '1' ? '' : 'html.is-shot-mode .work__skip{display:none !important;}',
      'html.is-shot-mode *,html.is-shot-mode{will-change:auto !important;}',
      'html.is-shot-mode *,html.is-shot-mode *::before,html.is-shot-mode *::after{' +
        'transition:none !important;animation:none !important;}',
      // `?paint=1`：把遮罩与被遮的舞台临时染成显眼色，用来判断「洞」到底画在哪。
      // 平时的填充色是 `--color-primary`，与 `.s-work` 自己的背景色完全相同——遮片与
      // 背景在像素上不可区分，光看截图判不出遮罩有没有按 scale 张开。
      devParams?.get('paint') === '1'
        ? 'html.is-shot-mode .s__mask__path-outer,html.is-shot-mode .s__mask__path-inner' +
          '{fill:#ff00ff !important;}' +
          'html.is-shot-mode .s__mask__path-lines{stroke:#ffff00 !important;stroke-width:2px !important;}' +
          'html.is-shot-mode .s__inner{background:#0033ff !important;color:#ffff00 !important;}'
        : '',
    ].join('\n');
    document.head.append(style);
    document.documentElement.classList.add('is-shot-mode');
  };

  /**
   * 把探针数据发给本机诊断汇（`.workbuddy/tmp/sink.mjs`）。
   *
   * headless 下这是唯一能拿回**纯文本**的通道：Edge 的两条 DevTools 端点都被系统级的
   * 选择性回环丢包 / 启动器脱离挡住，`--screenshot` 只回传像素；而页面**主动往本机发
   * 请求**是通的（Edge 连 vite 的 5199 一直正常，被挡的只是「连进 Edge 自己监听的
   * 端口」）。sendBeacon 走简单请求、不触发预检，也完全不关心响应。
   */
  const beacon = (payload: Record<string, unknown>): void => {
    try {
      const port = devParams?.get('sink') ?? '9099';
      navigator.sendBeacon(`http://127.0.0.1:${port}/probe`, JSON.stringify(payload));
    } catch {
      /* 没开 sink 时静默——这本就是可选的调试通道 */
    }
  };

  /** 采集一次指标快照；面板（画在截图上）与诊断汇（beacon 出去）共用这份数据。 */
  const collect = (progress: number): Record<string, unknown> => {
    const section = stage.element;
    const bodyStyle = getComputedStyle(document.body);
    const cards = [...section.querySelectorAll<HTMLElement>('.a-work')];
    const values = cards.map((card) => Number(card.style.getPropertyValue('--progress')));
    const live = values.filter((value) => Number.isFinite(value) && Math.abs(value) < 0.9999);
    const scene = section.querySelector<HTMLElement>('.s__scene');
    const mask = section.querySelector<HTMLElement>('.s__mask');
    const letter = section.querySelector<HTMLElement>('.s__scene__letter');
    const inner = section.querySelector<HTMLElement>('.s__inner');
    const box = (el: HTMLElement | null): string => {
      if (!el) return '-';
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const faces: string[] = [];
    if (document.fonts) {
      document.fonts.forEach((face) => {
        if (face.family.includes('Archivo')) faces.push(`${face.family}/${face.status}`);
      });
    }

    /*
     * 遮罩几何的深度读数。
     *
     * 为什么非要有这一段：遮罩的 fill 用的是 `--color-primary`，和 `.s-work` 自己的
     * 背景色**完全相同**——于是「遮片」与「背景」在像素上不可区分，截图里看到的那个
     * 深色胶囊到底是不是「洞」，光看图根本判不出来。只能把几何直接读出来比对：
     * mask 的高度应该 = 100lvh（不是整段高），「洞」应该来自 ruler 的位置/尺寸。
     */
    const maskSvg = section.querySelector<HTMLElement>('.s__mask__svg');
    const pathOuter = section.querySelector<SVGPathElement>('.s__mask__path-outer');
    const maskStyle = mask ? getComputedStyle(mask) : null;
    const maskChain = mask
      ? [
          `pos=${maskStyle?.position}`,
          `h=${maskStyle?.height}`,
          `w=${maskStyle?.width}`,
          `tf=${maskStyle?.transform}`,
          `org=${maskStyle?.transformOrigin}`,
        ].join(' ')
      : null;
    const rulerBox = section.querySelector<HTMLElement>('.s__ruler');
    const outerBox = section.querySelector<HTMLElement>('.s__mask-outer');
    const rulerRect = rulerBox?.getBoundingClientRect();
    const outerStyle = outerBox ? getComputedStyle(outerBox) : null;

    /*
     * 三条遮罩 path 的**绘制顺序**。SVG 按文档顺序绘制，而 `path-inner` 是一块不透明的
     * 挖洞遮片（`fill` + `fill-rule: evenodd`）——顺序写错它就会把 `path-lines`（参考线
     * 网格）与 `path-outer`（外沿描边）整片盖死，且它自己带的 48px 位移会露在胶囊外面。
     * 参考站的静态 HTML 是 inner → outer → lines，这里直接读出来自证。
     */
    const pathOrder = [...section.querySelectorAll<SVGPathElement>('.s__mask__svg > path')]
      .map((node) => node.classList[0]?.replace('s__mask__path-', '') ?? '?')
      .join('>');

    // 段的两条边（视口坐标）。`--scroll-progress` 完全由它们与视口高决定。
    const sectionRect = section.getBoundingClientRect();

    return {
      wp: Number.isFinite(progress) ? Number(progress.toFixed(4)) : null,
      scrollY: Math.round(window.scrollY),
      innerH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
      bodyPos: `${bodyStyle.position} top=${bodyStyle.top} overflow=${bodyStyle.overflow}`,
      bodyClass: document.body.className,
      section: box(section),
      outer: box(section.querySelector<HTMLElement>('.s__outer')),
      maskOuter: box(outerBox),
      maskOuterStyle: outerStyle ? `pos=${outerStyle.position} h=${outerStyle.height}` : null,
      inner: box(inner),
      innerPos: inner ? getComputedStyle(inner).position : null,
      scene: box(scene),
      mask: box(mask),
      maskChain,
      maskSvgWH: maskSvg ? `${maskSvg.style.width} x ${maskSvg.style.height}` : null,
      ruler: rulerBox ? `${Math.round(rulerRect?.width ?? 0)}x${Math.round(rulerRect?.height ?? 0)}` : null,
      maxScale: rulerRect && rulerRect.width > 0 ? Number((window.innerWidth / (rulerRect.width / 2)).toFixed(3)) : null,
      dHead: (pathOuter?.getAttribute('d') ?? '').slice(0, 44),
      ghosts: section.querySelectorAll('.s__scene__letter').length,
      cards: cards.length,
      live: live.length,
      liveSample: live.slice(0, 4).map((value) => Number(value.toFixed(3))),
      state: scene?.style.getPropertyValue('--state') ?? null,
      maskScale: mask?.style.transform ?? null,
      sceneTx: scene?.style.transform ?? null,
      letterW: letter ? Math.round(letter.getBoundingClientRect().width) : null,
      font: letter ? getComputedStyle(letter).fontFamily.split(',')[0] : null,
      faces,
      // `?live=1` 专用：生产路径（ScrollTrigger 驱动）的读数。
      stagedProgress: Number(stage.progress().toFixed(4)),
      // 三层视差的唯一驱动量 + 它的两个输入（`?sp=` 钉住时看这里有没有真的钉上）。
      sp: section.style.getPropertyValue('--scroll-progress') || '(unset)',
      sectionEdges: `${Math.round(sectionRect.top)}..${Math.round(sectionRect.bottom)} / vh ${window.innerHeight}`,
      pathOrder,
      // 交接处的四个兄弟块，各自相对 `.s-work` 顶边的偏移（**与滚动无关**：两者一起动，
      // 相减就消掉了）。期望读数是 `sep=-36, work=0, sep=+15300, my-way=+15336`。
      // 用文本读数验交接处，比截图可靠——固定舞台在 `?live=` 下会被推出截图画面。
      siblings: [...root.children]
        .map((child) => {
          const kind = child.classList.contains('s-work') ? 'work' : child.classList.contains('s-my-way') ? 'my-way' : child.classList.contains('a-separator') ? 'sep' : child.tagName.toLowerCase();
          return `${kind}=${Math.round(child.getBoundingClientRect().top - sectionRect.top)}`;
        })
        .join(' '),
    };
  };

  /**
   * `?live=<progress>`：在**真实滚动**下验证生产路径。
   *
   * 之所以必须单独验一次：上面那套 `?wp=` 截图是「冻帧 + 手动 seek」，它把 ScrollTrigger
   * 摘掉了——它证明得了时间轴的形状，证明不了「滚动推不推得动它」。而这台机器上没有任何
   * DevTools 通道可以交互式滚动，只能让页面自己来：二分搜索出一个滚动位置，使得
   * ScrollTrigger 算出的进度等于目标值，然后回报。若二分能收敛到目标进度，说明
   * start/end/scrub 的挂载是通的。
   *
   * `ScrollTrigger.update()` 是必需的：`scrollTo()` 之后 ScrollTrigger 要等下一帧才重算，
   * 而二分不能等帧。
   *
   * **二分收敛后要给 `scrub: 1` 留出追赶时间。** 时间轴挂的是 `scrub: 1`——它自己还有
   * 约 1 秒的追赶动画，seek 完立刻读到的 `progress` / `--scroll-progress` 都是上一帧的旧值
   * （实测目标 0.75 只能读到 0.57）。所以这里起一串 `settled` 采样：每 100ms 读一次、
   * 连读 12 次。**判读一律取同一 `scrollY` 下的最后一条 `settled`**；`at:'live'` 那条
   * 只说明二分收敛到了目标位置。
   *
   * 为什么不用「等 1.5 秒再报一条」：`--screenshot` 抓完就结束浏览器进程，页面寿命
   * 只有 1.2 秒上下，长定时器根本来不及跑（实测 1500ms 的复测一条都收不到）。
   * 密集采样还有个好处——同一 `scrollY` 的连续几条能直接看出「追上了没有」。
   */
  /**
   * `?live=` 的采样轮只起一届。
   *
   * `applyDevUrlState` 会在 120/320/640/1000ms 各跑一次 `runLiveSeek`（为了顶住开场那几屏
   * 反复把自己的滚动拉回去）。若每次都挂一串采样，一个页面就要发 60 多条读数、
   * 把共用 sink 刷满，而且后起的那些注定是被搅乱的噪声。只留第一轮。
   */
  let liveSettleStarted = false;

  const runLiveSeek = (target: number): void => {
    /** 文档高度会随字体/图片/下一板块的几何**在搜索过程中**继续变化（实测同一页里
     *  在 14179 / 14727 / 16542 / 17090 之间跳），而段的绝对偏移也随之漂移。
     *  所以每一步都重新量一次上界，并把区间夹回合法范围——否则一次过冲就会把区间
     *  推到错误的一侧，二分再也不收敛（实测目标 0.8 会落到 `scrollY = maxScroll`）。 */
    const measureMax = (): number => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const readAt = (y: number): number => {
      window.scrollTo(0, y);
      ScrollTrigger.update();
      return stage.progress();
    };
    let max = measureMax();
    let low = 0;
    let high = max;
    for (let step = 0; step < 24; step += 1) {
      const nowMax = measureMax();
      if (nowMax !== max) {
        max = nowMax;
        low = Math.min(low, max);
        high = Math.min(high, max);
      }
      const mid = (low + high) / 2;
      if (readAt(mid) < target) low = mid;
      else high = mid;
    }
    const y = (low + high) / 2;
    const progress = readAt(y);
    // 逐帧层要等下一帧才写，而这里要的是「此刻的真实值」——同步补一次。
    stage.refreshScrollProgress();
    beacon({
      at: 'live',
      target,
      scrollY: Math.round(window.scrollY),
      maxScroll: Math.round(max),
      progress: Number(progress.toFixed(4)),
      ...collect(progress),
    });

    if (liveSettleStarted) return;
    liveSettleStarted = true;

    const seekY = Math.round(y);
    let sample = 0;
    const sampleLoop = (): void => {
      sample += 1;
      ScrollTrigger.update();
      const settled = stage.progress();
      beacon({
        at: 'settled',
        target,
        sample,
        scrollY: Math.round(window.scrollY),
        seekY,
        progress: Number(settled.toFixed(4)),
        ...collect(settled),
      });
      if (sample < 12) window.setTimeout(sampleLoop, 100);
    };
    window.setTimeout(sampleLoop, 100);
  };

  /** 把快照画在左上角，让截图自身携带数字（即便 sink 没开也能读）。 */
  const mountProbe = (progress: number): void => {
    let panel = document.getElementById('__shot-probe');
    if (!panel) {
      panel = document.createElement('pre');
      panel.id = '__shot-probe';
      panel.style.cssText =
        'position:fixed;z-index:9999;left:0;top:0;margin:0;padding:5px 7px;' +
        'font:10px/1.45 ui-monospace,monospace;color:#0f2417;background:rgba(242,247,240,.68);' +
        'border-right:1px solid rgba(63,125,88,.5);border-bottom:1px solid rgba(63,125,88,.5);' +
        'white-space:pre;pointer-events:none;';
      document.body.append(panel);
    }
    panel.textContent = Object.entries(collect(progress))
      .map(([key, value]) => `${key.padEnd(15)} ${Array.isArray(value) ? value.join(' ') : String(value)}`)
      .join('\n');
  };

  /**
   * 落到 URL 指定的状态。
   *
   * **不滚动**。这一条是踩了很久的坑：`--headless --screenshot` 抓的是「文档第
   * 0 行到第 windowHeight 行」，而 `position: fixed` 的元素却按**真实滚动位置**摆放
   * ——于是只要滚过，固定定位的舞台就会被推到画面外（实测 window=900 时舞台从图像
   * y≈550 才开始，整幅只剩底下 350px 有内容，其余 100% 是浏览器的空白底色 #fcfcfc）。
   * 所以截图模式必须停在 scrollY=0，只用 `stage.setProgress()` 直接拨时间轴。
   *
   * 前提是 `installShotStyles()` 已经把 WORK 之前的板块整块拿掉了，本段因此从文档
   * 顶部开始，不滚动也能进画面。
   *
   * 自己先跑 `stage.layout()`：逐帧布局平时挂在 rAF 上，而 capture 可能就发生在 `load`
   * 附近甚至之前——不能赌 rAF 已经跑过。`withLayout=false` 供已量过尺寸的 `applyLayout` 复用。
   */
  const applyDevUrlState = (withLayout = true): void => {
    // `devShotMode` 这一层不能省：DEV 下 `devParams` 永远非空，若不拦，「普通 DEV 页面」
    // 每次 `applyLayout`（load / resize）都会被写入一个进度 0，白白把正在滚动的画面拽回
    // 开场一帧（随后会被 scrub 拉回来，但会闪一下）。
    if (!devParams || !devShotMode) return;
    const progress = Number(devParams.get('wp') ?? '0');

    if (withLayout) stage.layout();

    // 真实滚动路径：不碰时间轴，只把页面滚到位，让 ScrollTrigger 自己推。
    if (useLive && liveTarget !== null) {
      runLiveSeek(liveTarget);
      return;
    }

    if (Number.isFinite(progress)) stage.setProgress(progress);
    if (devParams.get('probe') === '1') mountProbe(progress);
    beacon({ at: 'applied', ...collect(progress) });
  };

  /** 实际量一次尺寸并重建（遮罩几何 / 幽灵阵列 / 时间轴）。 */
  const applyLayout = (): void => {
    stage.layout();
    if (reduced) stage.settle();
    ScrollTrigger.refresh();
    applyDevUrlState(false);
  };

  if (devShotMode) {
    // 先冻帧：摘掉时间轴的 ScrollTrigger。截图恒在 scrollY=0 下进行，ScrollTrigger 自己
    // 算出的进度也恒为 0，若不摘，它的 scrub 会在每次 refresh 里把 onUpdate 拉回塌缩态，
    // 把 setProgress() 覆盖掉（实测 wp=0.25 时探针读到 state=1，像素却是 state=0）。
    // `?live=` 例外——那一路要的正是活着的 ScrollTrigger。
    if (!useLive) {
      try {
        stage.setFreeze(true);
      } catch (error) {
        /* 冻帧失败不致命：最坏情况是截到被 scrub 拉回的帧，下面照旧继续 */
        void error;
      }
    }

    // 诊断标记：同步挂上去，先证明「代码跑到这里了」，再逐步追加状态。
    const mark = document.createElement('div');
    mark.id = '__shot-mark';
    mark.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;width:100%;padding:4px 10px;' +
      'font:12px monospace;background:#ff00ff;color:#000;white-space:pre-wrap;display:none;';
    const wantMark = devParams?.get('probe') === '1';
    let markShown = false;
    const showMark = (): void => {
      markShown = true;
      mark.style.display = 'block';
    };
    const steps: string[] = [
      `module ready=${document.readyState} head=${Boolean(document.head)} body=${Boolean(document.body)}`,
    ];
    const draw = (): void => {
      mark.textContent = steps.join('\n');
      if (wantMark || markShown) showMark();
    };
    draw();
    document.documentElement.append(mark);

    const note = (label: string, error: unknown): void => {
      const where = error instanceof Error ? (error.stack ?? '').split('\n')[1]?.trim() ?? '' : '';
      const detail = error instanceof Error ? `${error.message} @ ${where}` : String(error);
      steps.push(`${label}: ${detail}`);
      draw();
      // 出错时无论有没有 probe 都强制显示，否则就成了「悄悄白屏」。
      showMark();
      beacon({ at: 'error', label, detail });
    };
    window.addEventListener('error', (event) => note('window.error', event.error ?? event.message));
    window.addEventListener('unhandledrejection', (event) => note('rejection', event.reason));

    beacon({ at: 'module-eval', search: window.location.search, ready: document.readyState });

    // 让入口（main.ts）在整棵树挂载完之后**同步**落一次状态：这样它在 `load` 之前就位，
    // `--screenshot` 无论何时抓都抓得到正确的帧，不必赌定时器。
    (window as unknown as Record<string, unknown>).__shotApply = () => applyDevUrlState(true);

    try {
      installShotStyles();
      steps.push('shot-styles installed');
      draw();
    } catch (error) {
      note('installShotStyles', error);
    }

    // 前两屏的开场会在若干帧内反复把自己 scrollTo 回去，这里跟着再落几次，确保最终
    // 停在我们指定的位置。纯 DEV，生产构建里整段不存在。
    for (const delay of [120, 320, 640, 1000]) {
      window.setTimeout(() => {
        try {
          applyDevUrlState();
          steps.push(`t${delay} ok`);
        } catch (error) {
          note(`apply@${delay}`, error);
        }
        draw();
        if (delay === 1000) beacon({ at: 'done' });
      }, delay);
    }
  }

  /** 带滚动锁守卫的 `applyLayout`。 */
  const runLayout = (): void => {
    if (isPageLocked()) {
      deferUntilUnlocked(runLayout);
      return;
    }
    applyLayout();
  };

  let resizeFrame = 0;
  const measure = (): void => {
    stage.resize();
    outro.resize();
  };
  const onResize = (): void => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (isPageLocked()) {
        deferUntilUnlocked(measure);
        return;
      }
      measure();
    });
  };
  window.addEventListener('resize', onResize);

  // **关键时序**：`createWorksSection()` 是在 `root.append(shell)` **之前**跑完的，
  // 那一刻整棵子树还没有布局，所有 `getBoundingClientRect()` 都是 0——幽灵字母会
  // 按 0 字宽复制出错误的份数（总数为 0/字宽 = 2）、`speed` 归零（于是 `--progress`
  // 永不写入），遮罩也拿不到窗口尺寸。所以必须等它真正连上文档、过一帧之后重量一次。
  let layoutFrame = 0;
  const scheduleLayout = (): void => {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!root.isConnected) {
        scheduleLayout();
        return;
      }
      runLayout();
    });
  };
  scheduleLayout();

  // 字体落位后字宽才算准（幽灵字母是按原生字母的宽度复制份数的），必须重量一次；
  // `load` 兜住图片与其余素材。
  if (document.fonts) void document.fonts.ready.then(runLayout).catch(() => undefined);
  window.addEventListener('load', runLayout, { once: true });

  // 仅供截图脚本使用的确定性探针。`import.meta.env.DEV` 为假时整段会被打包器删掉。
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__workDebug = {
      setProgress: (progress: number) => stage.setProgress(progress),
      progress: () => stage.progress(),
      liveCards: () => stage.liveCardCount(),
      /** 冻住 GSAP ticker（Lenis 与逐帧层都挂在上面），让截图稳定在同一帧。 */
      pause: () => gsap.ticker.sleep(),
      resume: () => gsap.ticker.wake(),
      /** 直接滚到某个文档位置（绕开 Lenis 的插值，落点确定）。 */
      scrollTo: (y: number) => window.scrollTo(0, y),
      /** 段落几何：用于断言高度是否为 34 × 50lvh。 */
      metrics: () => {
        const rect = stage.element.getBoundingClientRect();
        return {
          height: rect.height,
          innerHeight: window.innerHeight,
          cards: stage.element.querySelectorAll('.a-work').length,
        };
      },
    };
  }

  /*
   * 真实作品数据到达后热替换整面墙。
   *
   * 放在函数末尾、`devShotMode` 判定之后，有两个原因：
   *   1. `devShotMode` 在函数中部才算出来（依赖 URL 参数），提前订阅会读不到它；
   *   2. 这里给的回调里会动 `--height`，必须晚于本段所有几何测量代码的声明，
   *      否则会踩 `const` 的暂时性死区。
   *
   * 失败一律静默：拿到不到数据就保留占位墙，首页照常可看——整条滚动叙事是站点主视觉，
   * 不该因为后端没起就变成一块空白。
   */
  if (options.cardsPromise && !devShotMode) {
    void options.cardsPromise
      .then((cards) => {
        if (disposed || cards.length === 0) return;
        // `setCards` 内部已经做完了「改高度 → 重建时间轴 → 静态终态复核 → refresh」，
        // 这里不再调 `applyLayout()`：那会把时间轴立刻再建一遍，白跑一次全量重建。
        stage.setCards(cards);
      })
      .catch(() => undefined);
  }

  return {
    element: root,
    layout: runLayout,
    setProgress: (progress: number) => stage.setProgress(progress),
    progress: () => stage.progress(),
    dispose: () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('load', runLayout);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
      unlockObserver?.disconnect();
      pendingLayout = null;
      outroObserver?.disconnect();
      outroEdgeObserver?.disconnect();
      skipTrigger.kill();
      skipButton.remove();
      separator.dispose();
      separatorOutro.dispose();
      stage.dispose();
      outro.dispose();
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__workDebug;
      root.remove();
    },
  };
}
