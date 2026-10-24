/**
 * “我是谁？”板块。
 *
 * 加高容器 + `position: sticky` 的内容区：滚到这一段画面会钉住，之后整段开场
 * 完全按本地时钟**自动播完**（十来秒），播放期间滚动被锁住，既不会快进也不会跳过：
 *
 *   1. 最初画面上一个字都没有；
 *   2. “我是谁？”按打字机逐字出现（带光标）；
 *   3. 小圆点从屏幕外飞进来，汇聚成方阵，长成方格，再翻面露出照片；
 *   4. 正文在这段时间里一直躲在“你好！”背后（所有字缩成一团叠在同一点）；
 *   5. “你好！”逐个字被打出来，停一拍，然后炸开；
 *   6. 炸开的同时正文从团里扩散出来，排到正确的位置——之后还可以用鼠标把字
 *      打散再让它弹簧归位（moveableText 那套效果）。
 *
 * 时间线是唯一的真相，而且只有本地时钟能推动它：滚动既不快进也不倒带，所以
 * “滑过头”只会被拉回钉住的位置，不会把动画瞬间跳到中间、再干等半天。滚动只管
 * 两件事——把这一屏顶进视口后开播，以及等动画播完之后放行继续往下滚。`.identity`
 * 多出来的那段高度就是放行后用来下沉让位的余量。
 */

import { createGreeting, type GreetingHandle } from '../scene/greeting';
import { createMoveableText, type MoveableTextHandle } from '../scene/moveable-text';
import { createPortraitPixel, type PortraitPixelHandle } from '../scene/portrait-pixel';
import { samplePortraitGrid } from '../scene/portrait-points';
import { prefersReducedMotion } from '../scene/text-support';
import { clearScrollLock, markScrollLocked } from '../scroll-lock';
import { PROFILE_CAPTION, PROFILE_TEXT, PROFILE_TITLE } from '../content/profile';

export interface IdentitySectionOptions {
  /** 头像的基名（不含 `-512.png` 这类后缀）。 */
  portraitSrc: string;
  /** 头像的像素宽度，用来拼 srcset。 */
  portraitWidths: readonly number[];
  title?: string;
  text?: string;
  caption?: string;
  /** “你好！”的内容。 */
  greeting?: string;
}

export interface IdentitySectionHandle {
  element: HTMLElement;
  dispose(): void;
}

// -- 开场时间线（毫秒，自开场起算）------------------------------------------

/** 留白一拍，然后开始打标题。 */
const TITLE_AT = 300;
const TITLE_MS = 1500;
/** 标题打完、光标在末尾停一拍之后淡出（随后进入头像汇聚）。 */
const TITLE_CARET_HIDE_AT = TITLE_AT + TITLE_MS + 550;
/** 标题打完稍停，粒子开始汇聚。 */
const ASSEMBLY_AT = TITLE_AT + TITLE_MS + 350;
/** 汇聚 → 变形 → 模糊 → 换图 → 模糊褪去，整段时长。 */
const ASSEMBLY_MS = 4000;
const ASSEMBLY_END = ASSEMBLY_AT + ASSEMBLY_MS;
/** “你好！”在粒子开始汇聚之后、马赛克成型之前打出来。 */
const GREETING_AT = ASSEMBLY_AT + 400;
/** 正文在“你好！”出现之前就收拢完毕，这段时间里正文完全不可见。 */
const GREETING_MS = 900;
/** 打完停一拍，然后散落消失。 */
const SCATTER_AT = GREETING_AT + GREETING_MS + 380;
const SCATTER_MS = 800;

/**
 * 正文接力出场的节奏：每个字在团心亮这么久就飞走，下一个字随即出现。
 * 这是用户能感知到的“出字速度”。
 */
const REVEAL_HOLD_MS = 16;
/** 最后一个字飞回原位所需的余量，用来算时间线总长。 */
const REVEAL_LAND_MS = 900;
/** 还没量出真实字数前的保守估计，避免时间线短到没排完就收尾。 */
const REVEAL_ESTIMATE = 420;
const TIMELINE_TAIL = 600;

/**
 * 排序阶段的关键时刻。全部由真实字数推出，所以文案长度变了时间线也会跟着变。
 */
const reveal = {
  /** 已经排好版的字数。 */
  count: REVEAL_ESTIMATE,
  /** 接力出场开始的时刻。 */
  start: 0,
  /** 整段排完（最后一个字也飞回位置）的时刻。 */
  land: 0,
  /** 整条开场时间线的长度。 */
  total: 0,
};

const syncReveal = (): void => {
  reveal.start = SCATTER_AT + SCATTER_MS;
  reveal.land = reveal.start + REVEAL_HOLD_MS * reveal.count + REVEAL_LAND_MS;
  reveal.total = reveal.land + TIMELINE_TAIL;
};

/** 用排版量出的真实字数重算时间线。 */
const setRevealCount = (count: number): void => {
  if (count <= 0 || count === reveal.count) return;
  reveal.count = count;
  syncReveal();
};

syncReveal();

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const span = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from));
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number): number => t * t;

export function createIdentitySection(options: IdentitySectionOptions): IdentitySectionHandle {
  const titleText = options.title ?? PROFILE_TITLE;
  const profileText = options.text ?? PROFILE_TEXT;
  const captionText = options.caption ?? PROFILE_CAPTION;
  const greetingText = options.greeting ?? '你好！';

  /** 减少动态偏好：不自动播放、不锁滚动，直接呈现最终状态。 */
  const reduced = prefersReducedMotion();

  const section = document.createElement('section');
  section.className = 'identity';
  section.id = 'about';

  const sticky = document.createElement('div');
  sticky.className = 'identity__sticky';

  const panel = document.createElement('div');
  panel.className = 'identity__panel';

  // -- 标题（打字机 + 光标）---------------------------------------------------

  const header = document.createElement('header');
  header.className = 'identity__header';

  const title = document.createElement('h2');
  title.className = 'identity__title';
  title.setAttribute('aria-hidden', 'true');

  const heading = document.createElement('h2');
  heading.className = 'identity__heading-a11y';
  heading.textContent = titleText;

  const titleGlyphs: HTMLElement[] = [];
  for (const char of titleText) {
    const glyph = document.createElement('span');
    glyph.className = 'identity__title-glyph';
    glyph.textContent = char;
    titleGlyphs.push(glyph);
    title.append(glyph);
  }

  // 光标放在标题内部，才能继承标题的字号（放在 header 里会继承正文字号，变得很小）。
  const caret = document.createElement('span');
  caret.className = 'identity__caret';
  caret.setAttribute('aria-hidden', 'true');
  title.append(caret);

  header.append(title, heading);

  // -- 头像 + 正文 ------------------------------------------------------------

  const body = document.createElement('div');
  body.className = 'identity__body';

  const portrait = document.createElement('figure');
  portrait.className = 'identity__portrait';

  const frame = document.createElement('div');
  frame.className = 'identity__frame';

  const image = document.createElement('img');
  image.className = 'identity__photo';
  // 用 srcset 让浏览器自己挑合适的那张。
  image.srcset = options.portraitWidths
    .map((width) => `${options.portraitSrc}-${width}.png ${width}w`)
    .join(', ');
  const largest = options.portraitWidths[options.portraitWidths.length - 1];
  image.src = `${options.portraitSrc}-${largest}.png`;
  image.sizes = '(max-width: 60rem) 58vw, 25rem';
  image.alt = `${titleText} 的肖像`;
  image.decoding = 'async';
  image.draggable = false;

  frame.append(image);

  const caption = document.createElement('figcaption');
  caption.className = 'identity__caption';
  caption.textContent = captionText;

  portrait.append(frame, caption);

  const bio = document.createElement('div');
  bio.className = 'identity__bio';

  // 真实、可选中、可朗读的正文；画布只在它上方画动画副本。
  const text = document.createElement('p');
  text.className = 'identity__text';
  text.textContent = profileText;

  // 舞台比正文大一圈，给炸开留余量。
  const textStage = document.createElement('div');
  textStage.className = 'identity__text-stage';

  const textCanvas = document.createElement('canvas');
  textCanvas.className = 'identity__text-canvas';
  textCanvas.setAttribute('aria-hidden', 'true');

  const greetingCanvas = document.createElement('canvas');
  greetingCanvas.className = 'identity__greeting';
  greetingCanvas.setAttribute('aria-hidden', 'true');

  // 两块画布贴在同一个舞台上，坐标系一致；盖在正文之上。
  textStage.append(textCanvas, greetingCanvas);
  bio.append(text, textStage);

  body.append(portrait, bio);

  const hint = document.createElement('p');
  hint.className = 'identity__hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = '继续向下滚动';

  panel.append(header, body, hint);
  sticky.append(panel);

  // 粒子层：铺满视口，所以点能从屏幕外飞进来而不被相框裁掉。
  const particleCanvas = document.createElement('canvas');
  particleCanvas.className = 'identity__particles';
  particleCanvas.setAttribute('aria-hidden', 'true');
  section.append(particleCanvas, sticky);

  // 跳过按钮：只在开场播放期间出现，钉在视口右下角。挂在 `<section>` 上而不是
  // `.identity__sticky` 里——后者带 `transform`，会成为 `position: fixed` 的包含
  // 块，把按钮拴在面板上一起动；`section` 只有 `position: relative`，不会。
  let skipButton: HTMLButtonElement | null = null;
  if (!reduced) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'identity__skip';
    button.textContent = '跳过';
    button.setAttribute('aria-label', '跳过开场动画');
    // 用箭头包一层：`skipIntro` 在本函数后面才定义，等真正点击时肯定已经就绪。
    button.addEventListener('click', () => skipIntro());
    section.append(button);
    skipButton = button;
  }

  // -- 状态 ------------------------------------------------------------------

  let particles: PortraitPixelHandle | null = null;
  let textEngine: MoveableTextHandle | null = null;
  let greeting: GreetingHandle | null = null;

  let timeline = 0;
  let scatterFired = false;
  let greetingTyped = false;
  let textGathered = false;
  /** 排序阶段（整团渐入 + 逐字散开）是否已经起步。 */
  let clumpFired = false;
  let scrollFrame = 0;
  let introFrame = 0;
  let introStart = 0;
  let introDone = false;
  let disposed = false;
  let lastPhase: 'idle' | 'pinned' | 'leaving' | null = null;
  /** 这一屏下沉的进度，用来决定颗粒层要不要收掉。 */
  let sinkValue = 0;

  // -- 滚动锁：动画自己播，播放期间不许滚走 ------------------------------------
  //
  // 之前滚动位置会直接改写时间线，滑过头就等价于“快进”——动画瞬间跳到中段，
  // 本地时钟却还得从零把这段补回来，于是画面先跳一下、再干等半天才继续。现在
  // 时间线只由本地时钟推进，播放期间把 `body` 冻住（`position: fixed` + `top`
  // 偏移 + `overflow: hidden`），只有等整段播完才解锁，滚动才重新可用。

  const lockRoot = document.body;
  let lockedScrollY = 0;
  /** 是否正钉住播放中。 */
  let holding = false;

  const applyLock = (): void => {
    if (holding) {
      if (reduced || lockRoot.classList.contains('is-identity-locked')) return;
      lockedScrollY = window.scrollY;
      // 告诉读 `window.scrollY` 的效果们（首屏视差、导航栏）真实位置在哪：锁上
      // 之后浏览器会把 scrollY 归零，不补这一下，收好的胶囊导航栏会重新铺开。
      markScrollLocked(lockedScrollY);
      // 把页面冻在当前视口位置，位置由 `top` 偏移兜住，视觉上不跳。
      lockRoot.style.top = `${-lockedScrollY}px`;
      lockRoot.classList.add('is-identity-locked');
      return;
    }
    if (lockRoot.classList.contains('is-identity-locked')) {
      lockRoot.classList.remove('is-identity-locked');
      lockRoot.style.top = '';
      // 先把真实位置写回去再恢复滚动，免得解锁瞬间视差 / 导航栏闪一下。
      window.scrollTo(0, lockedScrollY);
      clearScrollLock();
    }
  };

  /**
   * 这一屏顶进视口：把它拉回钉住起点并锁住滚动，然后按本地时钟自动播放。
   * 返回是否真的刚进入播放（已经播过 / 正在播时返回 false）。
   */
  const enterPlay = (): boolean => {
    if (holding || introDone || reduced || section.offsetHeight === 0) return false;
    // 滑过头时这一屏可能已经被推下去一截；先拉回到钉住起点，保证动画从完整的
    // 一屏开始播，而不是播在一张已经滑走 / 沉掉的画面上。
    window.scrollTo(0, section.offsetTop);
    holding = true;
    applyLock();
    startIntro();
    // 播放期间浮出「跳过」按钮（开场很长，给用户一个出口）。
    showSkip();
    // 锁上之后页面不再产生滚动事件，这里按锁定后的位置补跑一次状态。
    update();
    return true;
  };

  /** 开场播完（或被跳过）就解锁放行，滚动重新可用（人停在原地）。 */
  const exitPlay = (): void => {
    if (!holding) return;
    holding = false;
    // 无论自然播完还是被跳过，离开播放态就先收起「跳过」按钮（淡出）。
    hideSkip();
    // 解锁后先量一次当前位置，把下沉的基线摆正，免得解锁瞬间画面跳一下。
    update();
    applyLock();
  };

  /** “你好！”和正文聚拢点所在的位置（相对正文舞台的坐标）。 */
  const textCentre = (): { x: number; y: number } => {
    const stageRect = textStage.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return {
      x: textRect.left - stageRect.left + textRect.width / 2,
      y: textRect.top - stageRect.top + textRect.height / 2,
    };
  };

  /** 把时间线设到 `value`，并把这一时刻应有的样子反映到界面。 */
  const setTimeline = (value: number): void => {
    timeline = Math.min(reveal.total, Math.max(0, value));

    // 标题：逐字吐出，光标跟着往前走。
    const typed = span(timeline, TITLE_AT, TITLE_AT + TITLE_MS);
    const perChar = 1 / Math.max(1, titleGlyphs.length);
    let typedCount = 0;
    titleGlyphs.forEach((glyph, index) => {
      const shown = typed > 0 && typed >= (index + 0.5) * perChar;
      glyph.classList.toggle('is-shown', shown);
      glyph.classList.toggle('is-typing', shown && typed < (index + 1.2) * perChar);
      if (shown) typedCount = index + 1;
    });

    // 光标跟在“刚敲出来的那个字”后面；打完后停在末尾。
    if (caret.parentElement === title) title.removeChild(caret);
    const anchor = titleGlyphs[Math.max(0, typedCount - 1)];
    if (anchor) anchor.after(caret);
    caret.classList.toggle('is-typing', typed > 0 && typed < 1);
    caret.classList.toggle('is-holding', typed >= 1 && timeline < TITLE_CARET_HIDE_AT);
    caret.classList.toggle('is-gone', timeline >= TITLE_CARET_HIDE_AT);

    // 头像：汇聚 -> 变形 -> 模糊 -> 换图 -> 模糊褪去。
    particles?.setProgress(span(timeline, ASSEMBLY_AT, ASSEMBLY_END));
    // 说明文字跟着模糊一起显出来。
    portrait.style.setProperty(
      '--reveal',
      easeOut(span(timeline, ASSEMBLY_END - 1200, ASSEMBLY_END)).toFixed(4),
    );

    // 正文：在“你好！”出现**之前**就缩成一团藏好（所以从“你好！”打出到散落
    // 消失之前，正文都完全看不见）；散落消失之后，整团在段落中心渐入，再从第一
    // 个字开始依次弹回原位。聚拢要一直保持到排完为止，中途 settle() 会让所有字
    // 瞬间归位，动画就没了。
    const gatherT = span(timeline, GREETING_AT - 700, GREETING_AT - 300);
    const gathered = gatherT > 0 && timeline < reveal.land;
    if (!textEngine) {
      textGathered = gathered;
    } else if (gathered && !textGathered) {
      const origin = textCentre();
      textEngine.gather(origin.x, origin.y);
      textGathered = true;
    } else if (!gathered && textGathered) {
      textEngine.settle();
      textGathered = false;
    }
    // 正文画布等“你好！”打完才显形（此时字已经聚成一团且全透明，正好完整地藏
    // 在它背后）。用类切换而不是插值，避免淡入过程中露出半透明的团。
    section.classList.toggle('is-text-on', timeline >= GREETING_AT + GREETING_MS - 120);

    // “你好！”：打字（光标跟着字后退、打完淡出）-> 散落消失。
    if (timeline >= GREETING_AT && !greetingTyped) {
      greetingTyped = true;
      greeting?.typeIn();
    } else if (timeline < GREETING_AT - 400 && greetingTyped) {
      greetingTyped = false;
      greeting?.reset();
    }

    if (timeline >= SCATTER_AT && !scatterFired) {
      scatterFired = true;
      greeting?.scatter();
    } else if (timeline < SCATTER_AT - 500 && scatterFired) {
      scatterFired = false;
      greeting?.typeIn();
    }

    // 接力出场：整团渐入 + 逐字散开。交给引擎按自己的时钟跑，这里只负责起步。
    if (timeline >= reveal.start && !clumpFired) {
      clumpFired = true;
      textEngine?.clump(REVEAL_HOLD_MS / 1000);
    } else if (timeline < reveal.start - 200 && clumpFired) {
      clumpFired = false;
    }

    // 时间线跑完就把问候语画布收掉，彻底交还正文。
    greetingCanvas.style.opacity = timeline <= reveal.total - 400 ? '1' : '0';
    syncParticles();
  };

  /** 粒子层的显隐：模糊褪去、照片接管之后就收掉；下沉时也收掉。 */
  const syncParticles = (): void => {
    const settled = timeline >= ASSEMBLY_END - 250;
    particleCanvas.style.opacity = settled || sinkValue > 0.001 ? '0' : '1';
  };

  // -- 跳过：开场太长时一键落到终态 ------------------------------------------

  const showSkip = (): void => skipButton?.classList.add('is-visible');
  const hideSkip = (): void => skipButton?.classList.remove('is-visible');

  /**
   * 跳过开场：把时间线直接拉到末端、让各引擎落到「已归位」的终态，再释放滚动
   * 锁——和自然播完走同一条收尾路径（`exitPlay`）。
   *
   * 关键：**先**把各阶段标记为已触发，再 `setTimeline()`。否则 `setTimeline` 会看
   * 到 `!clumpFired` 而调用 `textEngine.clump()`，让正文再逐字排好几秒——那正是
   * 要跳过的东西。问候语（typeIn / scatter）同理，标记后对应分支直接跳过，不会把
   * 「你好！」重新点着。
   */
  const skipIntro = (): void => {
    if (disposed || reduced || introDone) return;
    greetingTyped = true;
    scatterFired = true;
    clumpFired = true;
    textEngine?.settle();
    textGathered = false;
    introDone = true;
    if (introFrame) {
      window.cancelAnimationFrame(introFrame);
      introFrame = 0;
    }
    setTimeline(reveal.total);
    exitPlay();
  };

  // -- 滚动：只负责开播 / 收尾 / 放行 -----------------------------------------

  const update = (): void => {
    scrollFrame = 0;
    const rect = section.getBoundingClientRect();
    // 元素还没挂进文档时 rect 全是 0，任何判断都没有意义。
    if (rect.height === 0) return;

    // 滚动不再改写时间线：`timeline` 只由本地时钟（introStep）推进，所以滑过头
    // 不会快进、更不会让画面干等。这里只处理钉住 / 放行和下沉。
    // （刷新时若浏览器恢复到本屏下方，rect.top 为负、bottom 也在视口上方，
    //   `enterPlay` 不会被触发，开场自然跳过。）

    if (reduced) {
      sinkValue = 0;
      section.style.setProperty('--act-sink', '0');
      syncParticles();
      return;
    }

    // 这一屏顶到视口顶端（sticky 就位）才钉住开播；在此之前先让它正常滑上来，
    // 免得锁得太早、一大块内容卡在视口下方。enterPlay 内部会自己补跑一次状态。
    if (rect.top <= 0 && enterPlay()) return;

    // 解锁之后页面继续往下滚，本屏往上移出；让位（下沉 / 淡出）发生在移出过程
    // 的后半段。开场没播完之前一律不下沉，免得动画播在一张已经沉掉的画面上。
    const runway = section.offsetHeight - window.innerHeight;
    const p = runway > 0 ? clamp01((window.scrollY - section.offsetTop) / runway) : 0;
    const sink = introDone ? easeIn(span(p, 0.5, 1)) : 0;
    sinkValue = sink;
    section.style.setProperty('--act-sink', sink.toFixed(4));
    syncParticles();

    // 告诉枫叶场景现在是不是“停在这一屏看戏”。
    const phase: 'idle' | 'pinned' | 'leaving' =
      rect.top > 0 ? 'idle' : rect.bottom <= window.innerHeight + 1 ? 'leaving' : 'pinned';
    if (phase !== lastPhase) {
      lastPhase = phase;
      document.body.dataset.identityPhase = phase;
      document.body.dataset.identityPinned = phase === 'pinned' ? '1' : '0';
    }
  };

  const onScroll = (): void => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(update);
  };

  // 粒子层是 fixed 的，滚动了要重新读相框位置。
  const onScrollSync = (): void => particles?.sync();

  // 时间线播完之后，鼠标在正文上划过可以把字蹭开，再靠弹簧归位
  // （moveableText 的效果）。只在完全归位后才生效，不和开场抢。
  let lastPointerX = 0;
  let lastPointerY = 0;
  let pointerTracked = false;

  const onTextPointerMove = (event: PointerEvent): void => {
    if (disposed || timeline < reveal.total) {
      pointerTracked = false;
      return;
    }
    if (!pointerTracked) {
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      pointerTracked = true;
      return;
    }
    const vx = event.clientX - lastPointerX;
    const vy = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    if (Math.hypot(vx, vy) < 2) return;
    textEngine?.stir(event.clientX, event.clientY, vx, vy);
  };

  const onTextPointerLeave = (): void => {
    pointerTracked = false;
  };

  textStage.addEventListener('pointermove', onTextPointerMove, { passive: true });
  textStage.addEventListener('pointerleave', onTextPointerLeave, { passive: true });

  // -- 本地时钟：不需要滚动也能播完 -------------------------------------------

  const introStep = (now: number): void => {
    if (disposed || introDone) return;
    const elapsed = now - introStart;
    if (elapsed > timeline) setTimeline(elapsed);
    if (elapsed >= reveal.total) {
      introDone = true;
      introFrame = 0;
      // 整段播完，解锁放行，用户继续往下滚去看后面的内容。
      exitPlay();
      return;
    }
    introFrame = window.requestAnimationFrame(introStep);
  };

  const startIntro = (): void => {
    if (introDone || introFrame || disposed) return;
    if (section.offsetHeight === 0) return;
    introStart = performance.now() - timeline;
    introFrame = window.requestAnimationFrame(introStep);
  };

  // -- 效果构建 ---------------------------------------------------------------

  const buildEffects = async (): Promise<void> => {
    // 必须等板块真正挂进文档、拿到布局之后再建画布：否则 getBoundingClientRect
    // 全是 0，画布会被开成默认的 300×150，字号换算也会错。
    while (!disposed && section.offsetHeight === 0) {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }
    if (disposed) return;

    try {
      if (!image.complete) await image.decode().catch(() => undefined);
      if (disposed) return;
      if (!image.naturalWidth) throw new Error('portrait image failed to decode');

      const grid = await samplePortraitGrid(image, 640, 20);
      if (disposed) return;

      particles = createPortraitPixel({
        canvas: particleCanvas,
        frame,
        points: grid.points,
        gap: grid.gap,
        image,
      });

      textEngine = createMoveableText({
        host: textStage,
        canvas: textCanvas,
        source: text,
        color: '#3a5a48',
        // 必须小于舞台的 inset，字才不会被画布边缘切掉。
        maxOffset: 68,
      });

      // 写入阶段的长短按排版出来的真实字数算，文案改了时间线也会跟着变。
      setRevealCount(textEngine.glyphCount());

      greeting = createGreeting({
        host: textStage,
        canvas: greetingCanvas,
        source: text,
        text: greetingText,
        color: '#2f6244',
        caretColor: '#2f6244',
        flare: '#c68442',
        // 明显大于正文，让“你好！”成为这一屏的主角。
        fontScale: 4.2,
        // 打字节奏和板块时间线上的 GREETING_MS 对齐。
        stagger: GREETING_MS / 1000 / Math.max(1, [...greetingText].length),
      });
    } catch (error) {
      // 装饰性动画失败不能拖垮板块：真实文字和照片本来就摆在页面上。
      console.warn('identity section effects failed to start', error);
    }

    section.classList.add('is-live');

    // 快速滚动可能已经越过某些节点，这里按当前时间补齐状态。开场已经播完 / 被
    // 跳过（introDone）时不再补点，免得把「你好！」的引擎又点着。
    if (!introDone && timeline >= GREETING_AT) {
      greetingTyped = true;
      greeting?.typeIn();
    }
    if (!introDone && timeline >= SCATTER_AT) {
      scatterFired = true;
      greeting?.scatter();
    }
    setTimeline(timeline);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScrollSync, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('resize', onScrollSync);

  // 两个观察器分工：这个负责“开始”，下面那个负责“离开视口时停掉画布循环”。
  const entrance = new IntersectionObserver(
    () => {
      const rect = section.getBoundingClientRect();
      if (rect.top <= 0) enterPlay();
    },
    { threshold: [0, 0.3, 0.6, 1] },
  );
  entrance.observe(section);

  const visibility = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      greeting?.setActive(visible);
      textEngine?.setActive(visible);
      if (visible) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= 0) enterPlay();
      }
    },
    { threshold: 0 },
  );
  visibility.observe(section);

  if (reduced) {
    section.classList.add('is-reduced');
    section.style.setProperty('--act-sink', '0');
    portrait.style.setProperty('--reveal', '1');
    particleCanvas.style.display = 'none';
    textStage.style.display = 'none';
    caret.style.display = 'none';
    hint.style.display = 'none';
    titleGlyphs.forEach((glyph) => glyph.classList.add('is-shown'));
  } else {
    section.classList.add('is-live');
    void buildEffects().then(() => {
      const rect = section.getBoundingClientRect();
      if (rect.top <= 0) enterPlay();
    });
  }

  update();

  return {
    element: section,
    dispose: () => {
      disposed = true;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScrollSync);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('resize', onScrollSync);
      textStage.removeEventListener('pointermove', onTextPointerMove);
      textStage.removeEventListener('pointerleave', onTextPointerLeave);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      if (introFrame) window.cancelAnimationFrame(introFrame);
      // 万一在钉住播放期间被销毁，别把滚动锁留给页面。
      if (lockRoot.classList.contains('is-identity-locked')) {
        lockRoot.classList.remove('is-identity-locked');
        lockRoot.style.top = '';
        clearScrollLock();
      }
      entrance.disconnect();
      visibility.disconnect();
      // 跳过按钮连着它的监听一起从文档里摘掉。
      skipButton?.remove();
      skipButton = null;
      particles?.dispose();
      textEngine?.dispose();
      greeting?.dispose();
    },
  };
}
