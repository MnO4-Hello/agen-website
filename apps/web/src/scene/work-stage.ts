/**
 * WORK 段的主舞台——参考站 `.s-work` 的移植。
 *
 * 结构（逐字对齐参考站）：
 *
 *   section.s-work[style="--height: 34*50lvh"]
 *     .s__outer                       ← 只负责提供滚动行程 + 用 clip-path 裁剪
 *       .s__inner                     ← position: fixed，被上面的 clip 限制在本段内
 *         h2.s__title > .s__title__inner > 4× .s__title__letter
 *         .s__scene                   ← perspective: 40rem；幽灵字母与卡片都挂这里
 *         canvas.s__canvas
 *       .s__mask-outer > .s__mask > svg
 *       .s__ruler
 *
 * **为什么能把一屏「钉住」**：`.s__inner` 是 `position: fixed`，但它被祖先
 * `.s__outer` 的 `clip-path: inset(0 -1rem)` 裁剪——clip 会把整棵子树（含 fixed
 * 后代）一起裁掉，所以这层只在 `.s__outer` 的纵向范围内可见，看起来就像被钉住了。
 * 因此 `.s-work` 的**任何祖先都不能有 `transform/filter/perspective/contain`**，
 * 否则 `.s__inner` 的包含块会变、fixed 语义失效（`.app-shell` 只有 `relative`，安全）。
 *
 * **时间轴**：一条 ScrollTrigger 时间轴（`scrub: 1`），前段把遮罩张开，中段让 34 张卡
 * 从 `p = 1` 一路推到 `p = -1`（右侧飞入 → 穿过中央 → 左侧飞出），后段再反向合拢。
 * 所有被动的属性都先写在 `driver` 这个普通对象上，再在 `onUpdate` 里一次性落到行内
 * 样式——和本站「逐帧写行内样式」的纪律一致，也让进度可以精确复现。
 */

import { gsap, ScrollTrigger, WORK_CARD_EASE } from './gsap-support';
import { WORK_LVH_PER_CARD, type WorkCardContent } from '../content/works';
import { createWorkCard, type WorkCardHandle } from './work-card';
import { createWorkLetters } from './work-letters';
import { createWorkMask, type WorkMaskHandle } from './work-mask';
import { createWorkPoints, type WorkPointsHandle } from './work-points';

/** 开场 / 收尾那段的时长（时间轴单位，不是秒——scrub 把它映射到滚动行程上）。 */
const ACT_DURATION = 0.75;

/**
 * 单张卡片横穿的时长。
 *
 * 参考站这一条 tween **没有写 duration**，吃的是 GSAP 默认值 0.5；配合
 * `stagger: .25`，同屏同时飞着的只有 0.5 / 0.25 ≈ 2~3 张。之前那版写成 1.2，
 * 同屏挤了 5 张，观感一下子就散了——这是「不够还原」的一个直接来源。
 */
const CARD_DURATION = 0.5;

/** 相邻卡片的错峰；决定同屏同时飞着几张。 */
const CARD_STAGGER = 0.25;

/** 点阵收缩段的时长。 */
const POINTS_DURATION = 1;

export interface WorkStageOptions {
  readonly cards: readonly WorkCardContent[];
  /** 竖排大字的文字（参考站是 `WORK`）。 */
  readonly title: string;
}

export interface WorkStageHandle {
  /** `section.s-work` */
  readonly element: HTMLElement;
  /**
   * 热替换整面墙的卡片（首页作品墙接真实数据用）。
   *
   * 传空数组是「什么都不做」——调用方在数据为空时应当保留原有的占位墙，
   * 这里不允许把板块高度写成 0。
   */
  setCards(cards: readonly WorkCardContent[]): void;
  /**
   * DEV 截图专用：冻住时间轴。
   *
   * 冻帧后**不再给时间轴挂 ScrollTrigger**，它变成一条暂停的普通时间轴，只认
   * `setProgress()`。原因：截图必须在 `scrollY = 0` 下进行（`--headless --screenshot`
   * 只抓文档前 `windowHeight` 行，而 `position: fixed` 的元素是按「滚动后的视口」
   * 摆放的），于是 ScrollTrigger 自己算出的进度恒为 0，`scrub` 会在每次
   * `refresh` / 滚动事件里把 `onUpdate` 拉回来，把 `setProgress()` 的结果覆盖掉。
   * 生产路径完全不受影响——只有 URL 带 `?wp=` / `?probe=` 时才打开。
   */
  setFreeze(frozen: boolean): void;
  /**
   * DEV 截图专用：把 `--scroll-progress` 钉死在指定值（传 `null` 恢复正常计算）。
   *
   * 理由与 `setFreeze` 完全相同——冻帧截图必须停在 `scrollY = 0`，而本段又从文档顶部
   * 开始，于是 `rect.top = 0`、`rect.bottom ≫ 视口`，三段式算出来**恰好是 0**。
   * 也就是说「钉住期间漂不漂」这一层，冻帧截图**永远看不见**（这次漏掉的两个缺陷之一
   * 正藏在这里）。有了这个开关，−1 / 0 / +1 三档都能摆出来拍。
   */
  setScrollProgressOverride(value: number | null): void;
  /**
   * DEV 探针用：立刻按当前滚动位置重算一次 `--scroll-progress`。
   *
   * 逐帧层（`tick`）只在 `active` 时才写，而且 ticker 要等下一帧——`?live=` 的诊断
   * 是在 `window.scrollTo` 之后**同步**取读数的，那一刻还没有任何一帧跑过，读到的会是
   * 上一段行程遗留的旧值（实测有时是 `(unset)`）。这里给一个同步的「现在就算」入口。
   */
  refreshScrollProgress(): void;
  /** 把时间轴拨到指定进度并立即渲染（DEV 探针用）。 */
  setProgress(progress: number): void;
  /** 当前时间轴进度，用于调试与回归断言。 */
  progress(): number;
  /** `prefers-reduced-motion`：直接摆一个静态终态。 */
  settle(): void;
  /** 挂载后必须调一次：此时才有真实布局，遮罩/幽灵/时间轴都依赖量出来的尺寸。 */
  layout(): void;
  /** 视口变化后重算遮罩/点阵/幽灵并重建时间轴。 */
  resize(): void;
  /** 当前是否有卡片在场（调试/断言用）。 */
  liveCardCount(): number;
  dispose(): void;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * `--scroll-progress` 的取值——参考站的**三段式**，不是「整段线性 0→1」。
 *
 * 参考站原式（`ref-hoisted.js` 的 `vc.tick()`，其中 `positionInViewport(el,'top'|'bottom')`
 * 就是 `rect.top|bottom / 视口高`，锚点表 `nn = { top: 0, bottom: 1 }`）：
 *
 *   −clamp01(rect.top / 视口高) + (1 − clamp01(rect.bottom / 视口高))
 *
 * 于是整段的取值是：**进入 −1 → 0 · 钉住期间恒为 0 · 离开 0 → +1**。
 * 后两段的差别是根本性的：`--scroll-progress` 驱动 `.s__inner` 的 −15%、
 * `path-inner` 的 +48px、`.s__canvas` 的 −5%。写成长 0→1（本站早期版本）会让这 17 屏的
 * 钉住期**一路缓慢漂移**——肉眼就是「暗底整块在上抬、底部绿条持续长高」。
 * 参考站在钉住期一寸不动，只在进/出场做一次位移。
 *
 * 抽成纯函数是为了能被回归断言直接喂数值（jsdom 没有真实布局，量不出来）。
 */
export function workScrollProgress(rectTop: number, rectBottom: number, viewport: number): number {
  if (!(viewport > 0)) return 0;
  return -clamp01(rectTop / viewport) + (1 - clamp01(rectBottom / viewport));
}

export function createWorkStage(options: WorkStageOptions): WorkStageHandle {
  const section = document.createElement('section');
  section.className = 'work s-work';
  section.id = 'work';

  const outer = document.createElement('div');
  outer.className = 's__outer';

  const container = document.createElement('div');
  container.className = 's__inner js-container';

  // —— 竖排大字 ——
  const title = document.createElement('h2');
  title.className = 's__title';
  title.setAttribute('aria-label', options.title);
  const titleInner = document.createElement('span');
  titleInner.className = 's__title__inner js-title';
  titleInner.setAttribute('aria-hidden', 'true');
  for (const glyph of options.title) {
    const letter = document.createElement('span');
    letter.className = 's__title__letter';
    letter.textContent = glyph;
    titleInner.append(letter);
  }
  title.append(titleInner);

  // —— 场景：幽灵字母 + 卡片 ——
  const scene = document.createElement('div');
  scene.className = 's__scene js-scene';

  /**
   * 卡片句柄与它们的时间轴代理。
   *
   * 用 `let` 而不是 `const`，是因为首页的作品墙会在数据到达后**整体换一批卡**
   * （见下面的 `setCards`）。这里踩过一次坑：只要有任何一个闭包捕获了旧数组，
   * 换卡之后那些位置仍在驱动已经被摘掉的 DOM——表现为「墙上是新的、飞过去是旧的」。
   * 所以所有读取点都必须走这两个变量名，不许再另存一份引用。
   */
  let cardHandles: WorkCardHandle[] = [];
  let proxies: Array<{ p: number }> = [];

  /**
   * 建卡、入 DOM、写板块高度。
   *
   * `--height = 卡片数 × 50lvh`（参考站公式），高度只由这里写一次；`setCards`
   * 换卡时必须重走这个函数，否则会出现「卡片变少了但行程还是 17 屏」。
   */
  const mountCards = (cards: readonly WorkCardContent[]): void => {
    cardHandles = cards.map((content, index) =>
      createWorkCard({ content, index, total: cards.length }),
    );
    proxies = cardHandles.map(() => ({ p: 1 }));
    for (const card of cardHandles) scene.append(card.element);
    section.style.setProperty('--height', `${cards.length * WORK_LVH_PER_CARD}lvh`);
  };

  mountCards(options.cards);

  const points: WorkPointsHandle = createWorkPoints();

  container.append(title, scene, points.element);

  const ruler = document.createElement('div');
  ruler.className = 's__ruler';

  // 遮罩的窗口几何直接来自 ruler 的位置与尺寸，所以 ruler 必须先于遮罩建好。
  const mask: WorkMaskHandle = createWorkMask({ section, ruler });
  const maskOuter = document.createElement('div');
  maskOuter.className = 's__mask-outer';
  maskOuter.append(mask.element);

  outer.append(container, maskOuter, ruler);
  section.append(outer);

  const letters = createWorkLetters({ scene, title: titleInner, container });

  /**
   * 时间轴驱动的全部标量。集中放这里，是为了让「一个进度 → 一套确定的行内样式」，
   * 进度可以随时被拨回去复现（截图验证就靠它）。
   */
  const driver = {
    state: 0,
    pointsProgress: 0,
    animationProgress: 0,
    maskScale: 1,
    sceneScale: 0.75,
    insetRem: 1,
  };

  /** 卡片各自的时间轴代理；`p = 1` 在右屏外，`p = 0` 正中，`p = -1` 在左屏外。 */
  // 代理与卡片同在 `mountCards()` 里成对重建，这里只是给个说明位置。

  let timeline: gsap.core.Timeline | null = null;

  /**
   * 是否已经进过「减少动态」的静态终态。
   *
   * `settle()` 会把时间轴整个 kill 掉；换卡后必须再走一次，否则新卡会停在
   * `--progress = 1`（右侧屏外），屏幕上什么都不剩。
   */
  let settledStatic = false;

  /**
   * 冻帧开关（见 `WorkStageHandle.setFreeze`）。置位后 `buildTimeline()` 就不再挂
   * ScrollTrigger——因为 `layout()` / `resize()` 都会重建时间轴，这个开关必须能穿过
   * 重建存活，否则冻帧只能维持到下一次布局。
   */
  let frozen = false;

  /**
   * DEV 截图用：把 `--scroll-progress` 钉在这个值上（`null` = 按真实滚动位置算）。
   * 必须存在闭包里而不是写成一次性赋值——`tick()` 每帧都会重写这个属性。
   */
  let scrollProgressOverride: number | null = null;

  /**
   * 冻帧期间最后一次被要求拨到的进度。
   *
   * 必须记着它：`layout()` / `resize()` 都会重建时间轴，而重建出来的是一条**停在第 0
   * 帧**的暂停时间轴——生产路径无所谓（ScrollTrigger 会立刻按滚动位置重新推一遍），
   * 冻帧路径没有任何东西来推，于是画面被悄悄退回开场。截图诊断里正是这个把「已经张开
   * 的遮罩」画了回去：探针读到 `tf=matrix(12,…)`，像素却是 scale(1)。
   */
  let frozenProgress = 0;

  /** 把 driver 的值一次性落到行内样式。时间轴的 onUpdate 与探针都会调它。 */
  const render = (): void => {
    scene.style.setProperty('--state', driver.state.toFixed(4));
    scene.style.transform = `scale(${driver.sceneScale.toFixed(4)})`;
    mask.element.style.transform = `scale(${driver.maskScale.toFixed(4)})`;
    container.style.clipPath = `inset(0 ${driver.insetRem.toFixed(3)}rem)`;
  };

  const pushCards = (): void => {
    for (let index = 0; index < cardHandles.length; index += 1) {
      cardHandles[index]?.setProgress(proxies[index]?.p ?? 1);
    }
  };

  /**
   * 量一次滚动位置并写 `--scroll-progress`。该值在 CSS 里驱动三层纵向位移
   * （`.s__inner` −15%、`path-inner` +48px、`.s__canvas` −5%，见 styles.css），
   * 取值语义见上面的 `workScrollProgress`——**钉住的整段恒为 0**，不能省。
   *
   * 注意 `getBoundingClientRect()` 会强制同步布局，而 gsap.ticker 从页面首帧起就一直
   * 在跑——所以**逐帧调用它的地方必须过视口门控**（见下面的 `tick`）。探针路径
   * （`setProgress` / `settle`）是直接调的：那是为了截图与静态终态，需要无条件算准。
   */
  const writeScrollProgress = (): void => {
    if (scrollProgressOverride !== null) {
      section.style.setProperty('--scroll-progress', scrollProgressOverride.toFixed(4));
      return;
    }
    const rect = section.getBoundingClientRect();
    section.style.setProperty(
      '--scroll-progress',
      workScrollProgress(rect.top, rect.bottom, window.innerHeight).toFixed(4),
    );
  };

  /**
   * 逐帧层：`--scroll-progress`、幽灵字母、点阵。三者都不在时间轴里，只读 driver /
   * 视口。
   *
   * 门控放在最前面：用户还在 hero / identity / skills 的时候，不该为 17 屏之外的这
   * 一段每帧付一次强制布局的代价。代价是刚进入视口那一帧 `--scroll-progress` 还是旧
   * 值（IntersectionObserver 回调比 ticker 晚一帧），而它只驱动 48px 级的位移，
   * 不可见。
   */
  const tick = (): void => {
    if (!active) return;
    writeScrollProgress();
    letters.update(driver.animationProgress);
    points.draw(driver.pointsProgress, driver.animationProgress);
  };

  const buildTimeline = (): void => {
    timeline?.kill();

    const cardSpan = CARD_DURATION + CARD_STAGGER * Math.max(0, cardHandles.length - 1);

    const tl = gsap.timeline({
      scrollTrigger: frozen
        ? undefined
        : {
            trigger: section,
            start: 'top 25%',
            end: 'bottom 75%',
            scrub: 1,
          },
      onUpdate: render,
    });

    // —— 前段：把遮罩的观察窗张开、场景推近、左右两条边收掉 ——
    tl.fromTo(driver, { maskScale: 1 }, { maskScale: mask.maxScale, duration: ACT_DURATION, ease: 'power4.in' }, 0);
    tl.fromTo(driver, { sceneScale: 0.75 }, { sceneScale: 1, duration: ACT_DURATION, ease: 'power3.in' }, 0);
    tl.fromTo(driver, { insetRem: 1 }, { insetRem: 0, duration: ACT_DURATION, ease: 'power3.in' }, 0);
    tl.fromTo(driver, { pointsProgress: 0 }, { pointsProgress: 1, duration: POINTS_DURATION, ease: 'power4.inOut' }, 0);
    // `state` 0 → 1 就是「叠在一起的 WORK 炸成跑马灯」那一刻。
    tl.fromTo(driver, { state: 0 }, { state: 1, duration: ACT_DURATION, ease: 'power4.in' }, 0);

    // —— 中段：34 张卡依次横穿 ——
    tl.fromTo(
      proxies,
      { p: 1 },
      {
        p: -1,
        duration: CARD_DURATION,
        // 参考站这里写的是字符串 `'slow(0.15, 0.6)'`，但那个字符串在 GSAP 3.15 的
        // ESM 构建里解析不出来（详见 gsap-support.ts），会静默退回 power1.out。
        // 这里传配置好的 SlowMo 函数，效果与参考站一致。
        ease: WORK_CARD_EASE,
        stagger: CARD_STAGGER,
        immediateRender: false,
        /*
         * `lazy: false` 不能省。
         *
         * GSAP 默认「惰性渲染」：一条 tween 第一次被渲染到之前不初始化。这里的 stagger
         * 会展开成 34 条子 tween，一旦某次 seek **一次跨过整段**（探针把进度从 0.5 直接拨
         * 到 1、或快速滚动时 scrub 的大幅追赶），最后一条子 tween 会「只被初始化、没有被
         * 推进」——表现为第 33 张卡的 `--progress` 停在起始值 1（右侧屏外），而其余 33 张
         * 都正常落到 -1。关掉惰性渲染后每条子 tween 建轴时就绑好，取值不再依赖渲染时机。
         */
        lazy: false,
        onUpdate: pushCards,
      },
      ACT_DURATION,
    );

    // 幽灵字母靠 animationProgress 一路涨到 1e4 驱动跑马灯，时长与整条轴对齐。
    tl.fromTo(
      driver,
      { animationProgress: 0 },
      { animationProgress: 1e4, duration: ACT_DURATION + cardSpan, ease: 'power1.out' },
      ACT_DURATION,
    );

    // —— 后段：从「1 个时长」处开始反向合拢 ——
    // 这几个 fromTo 的目标与前面相同，**必须** `immediateRender: false`：否则 GSAP
    // 在建轴时就把它们的起始值渲染上去，会把开场的状态整个覆盖掉（表现为一进场就是
    // 结束态）。
    const back = '-=1';
    tl.fromTo(driver, { state: 1 }, { state: 0, duration: ACT_DURATION, ease: 'power4.inOut', immediateRender: false }, back);
    tl.fromTo(driver, { maskScale: mask.maxScale }, { maskScale: 1, duration: ACT_DURATION, ease: 'power4.inOut', immediateRender: false }, back);
    tl.fromTo(driver, { sceneScale: 1 }, { sceneScale: 0.75, duration: ACT_DURATION, ease: 'power3.inOut', immediateRender: false }, back);
    tl.fromTo(driver, { insetRem: 0 }, { insetRem: 1, duration: ACT_DURATION, ease: 'power3.inOut', immediateRender: false }, back);
    tl.fromTo(driver, { pointsProgress: 1 }, { pointsProgress: 0, duration: POINTS_DURATION, ease: 'power4.inOut', immediateRender: false }, back);

    timeline = tl;
    // 冻帧的时间轴没有 ScrollTrigger 推它：必须自己停住（否则全局 ticker 会把它从头播
    // 到尾），并立刻 seek 回冻帧期间最后一次被要求的进度。
    if (frozen) {
      tl.pause();
      tl.progress(frozenProgress);
    }
    render();
  };

  // 卡片初始一律在右侧屏外，避免 CSS 里 `var(--progress)` 未定义导致 transform 失效、
  // 卡片散到左上角。
  pushCards();

  // 只有本段在视口里才跑逐帧层（参考站也是用 IntersectionObserver 门控）。
  let active = false;
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            active = Boolean(entries[entries.length - 1]?.isIntersecting);
          },
          { threshold: 0 },
        );
  observer?.observe(section);

  gsap.ticker.add(tick);

  /** 量一次尺寸并据此重建：遮罩几何、点阵、幽灵阵列、时间轴。 */
  const layout = (): void => {
    mask.resize();
    points.resize();
    letters.build();
    buildTimeline();
  };

  // 创建时的第一次铺排。注意此时本段**还没挂到 DOM 上**（`createWorksSection()`
  // 在 `root.append(shell)` 之前执行），所有 `getBoundingClientRect()` 都是 0，
  // 所以这一次只是让 DOM 处于一个合法状态；真正有效的布局由挂载后的
  // `layout()` 完成（见 sections/works.ts）。
  letters.build();
  buildTimeline();

  const resize = (): void => {
    layout();
    ScrollTrigger.refresh();
  };

  /**
   * 「减少动态」的静态终态：不建时间轴，直接摆一个能看清的构图。
   *
   * 抽成局部函数（而不是只做成句柄上的方法），因为 `setCards()` 换卡后也要再摆一次——
   * 句柄内部拿不到自己的 `settle`。
   */
  const applyStaticFrame = (): void => {
    settledStatic = true;
    timeline?.kill();
    timeline = null;
    mask.element.style.transform = `scale(${mask.maxScale.toFixed(4)})`;
    scene.style.transform = 'scale(1)';
    container.style.clipPath = 'inset(0 0rem)';
    scene.style.setProperty('--state', '0');
    driver.pointsProgress = 1;
    driver.animationProgress = 0;
    // 只留一张卡在正中央，其余全部退到屏外。
    cardHandles.forEach((card, index) => card.setProgress(index === 0 ? 0 : -1));
    letters.update(0);
    points.draw(1, 0);
    writeScrollProgress();
    ScrollTrigger.refresh();
  };

  return {
    element: section,
    setFreeze: (value) => {
      if (frozen === value) return;
      const keep = timeline?.progress() ?? frozenProgress;
      frozen = value;
      if (frozen) frozenProgress = keep;
      // 直接重建：只有重建才能干净地把 ScrollTrigger 摘掉。重建后立刻 seek 回原进度，
      // 调用方拿到的时间轴既不会被滚动推，也不会跳帧。
      buildTimeline();
      timeline?.progress(frozen ? frozenProgress : keep);
      render();
    },
    setScrollProgressOverride: (value) => {
      scrollProgressOverride = value === null || !Number.isFinite(value) ? null : value;
      // 立刻落一次：tick() 只在 `active` 时才写，而截图可能早于下一个 active 帧。
      writeScrollProgress();
    },
    refreshScrollProgress: () => writeScrollProgress(),
    setProgress: (progress) => {
      const value = clamp01(progress);
      if (frozen) frozenProgress = value;
      timeline?.progress(value);
      // 时间轴的 onUpdate / 卡片 tween 的 onUpdate 会随之触发；逐帧层不在时间轴里，
      // 所以这里手动补一次，保证「拨到哪一帧就是哪一帧」。
      letters.update(driver.animationProgress);
      points.draw(driver.pointsProgress, driver.animationProgress);
      writeScrollProgress();
    },
    progress: () => timeline?.progress() ?? 0,
    settle: () => applyStaticFrame(),
    resize,
    layout,
    /**
     * 热替换整面墙的卡片。
     *
     * 首页的数据是异步来的（`GET /api/works`），而 `router.start()` 必须同步把首屏
     * 建完，所以只能是「先用占位墙开场，数据到了再换」。顺序不能动：
     *
     *   dispose 旧卡 → 建新卡并写 `--height` → pushCards → layout()（重建时间轴）
     *   → 静态终态复核 → ScrollTrigger.refresh()
     *
     * 中途 `--height` 会变（张数变了），而 `layout()` 内部的 `buildTimeline()` 会带着
     * 新的 `cardHandles / proxies` 重建时间轴；冻帧路径的 `frozenProgress` 由
     * `buildTimeline()` 自己 seek 回去，不用在这里照顾。
     */
    setCards: (cards) => {
      // 空数据保留现有占位墙：把 `--height` 写成 0 会让整段塌掉，ScrollTrigger 的
      // start/end 全部算错，页面看起来像断了一截。
      if (cards.length === 0) return;

      for (const card of cardHandles) card.dispose();
      cardHandles = [];
      proxies = [];

      mountCards(cards);
      // 新卡一律先退到右侧屏外，避免 `var(--progress)` 未定义时散到左上角。
      pushCards();

      // layout() 里做 mask.resize / points.resize / letters.build / buildTimeline。
      layout();

      // 减少动态下时间轴已经被 kill：必须重新摆一次静态构图。
      if (settledStatic) applyStaticFrame();

      ScrollTrigger.refresh();
    },
    liveCardCount: () => cardHandles.filter((card) => card.isInView()).length,
    dispose: () => {
      observer?.disconnect();
      gsap.ticker.remove(tick);
      timeline?.kill();
      timeline = null;
      letters.dispose();
      points.dispose();
      mask.dispose();
      for (const card of cardHandles) card.dispose();
      section.remove();
    },
  };
}
