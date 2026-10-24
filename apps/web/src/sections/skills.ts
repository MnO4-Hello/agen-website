/**
 * “我会什么？”板块。
 *
 * 沿用整站的浅绿底（不另起深色背景）。滚动编排和 `identity.ts` 同源：加高容器
 * + `position: sticky` 把一屏钉住，用本地时钟推进一条时间线。
 *
 * 时间线（毫秒，自钉住起算）：
 *
 *   1. 标题「我会什么？」从屏幕上方落下，停在面板顶部；
 *   2. 左侧**先自绘出一张牌的轮廓**（上 → 右 → 下 → 左 顺时针，四条边分别
 *      长出来）。描完后卡面淡入——这个框就是牌堆的第一张牌，其余四张一开始
 *      就叠在它后面（同一位置），所以此刻看起来仍然只是一张牌；
 *   3. 牌堆展开：五张牌从这个叠着的初始位置散成扇形，右压左、各露一条边；
 *   4. 右侧更大的线框同样自绘描边 → 浅绿填充 → 粒子团汇聚成牌面大小；
 *   5. 下方浮出「请选择卡片」。
 *
 * 卡牌交互：指针移到某张牌上，它向左抽出、并**转正到水平**方便看清，指针离开
 * 再收回。位置由这里写进 `transform`；补间只在时间线跑完（`.is-settled`）之后
 * 才由 CSS 打开——否则动画期间逐帧写入会和 CSS 过渡互相打架，手感发黏。
 *
 * 在抽出的牌上**点一下**就把它「钉住」：牌一直悬着，右下角浮出一枚「放下」胶囊，
 * 点胶囊才收回去。钉住期间整个板块冻结（hover / 点击 / Tab 都不再改画面），
 * 所以出口唯一、状态不会两头改。胶囊挂在一个与牌同 transform 的幽灵层上。
 */

import { createOrbField, type OrbFieldHandle } from '../scene/orb-field';
import { createSwarmField, type SwarmFieldHandle } from '../scene/swarm-field';
import { createImageCompare } from '../scene/image-compare';
import { createPsBulbScene } from '../scene/ps-bulb';
import { createCodeTyping } from '../scene/code-typing';
import { createOfficeSuite } from '../scene/office-suite';
import { createAiLabScene } from '../scene/ai-lab';
import { inertSkillScene, type SkillSceneFactory, type SkillSceneHandle } from '../scene/skill-scene';
import { prefersReducedMotion } from '../scene/text-support';
import {
  SKILLS_CARDS,
  SKILLS_CARD_COUNT,
  SKILLS_PICK_HINT,
  SKILLS_PICK_SUB,
  SKILLS_RELEASE_LABEL,
  SKILLS_RELEASE_TEXT,
  SKILLS_TITLE,
  type SkillCardContent,
} from '../content/skills';

/**
 * 右栏场景工厂注册表——**新增场景只需在这里加一行**，并在卡片上写 `scene: 'id'`。
 *
 * `compare`（多图对比）不走这里：它需要预载第一张卡的图层，由 `buildEffects()` 单独
 * 登记进 `sceneHandles`。其余场景惰性创建（首次被选中时才建，省掉用不到的开销）。
 */
const SKILL_SCENE_FACTORIES: Record<string, SkillSceneFactory> = {
  'ps-bulb': (host) => createPsBulbScene({ host }),
  'code-typing': (host) => createCodeTyping({ host }),
  'office-suite': (host) => createOfficeSuite({ host }),
  'ai-lab': (host) => createAiLabScene({ host }),
};

export interface SkillsSectionOptions {
  /** 卡牌数量，默认 5。 */
  cardCount?: number;
  title?: string;
}

export interface SkillsSectionHandle {
  element: HTMLElement;
  dispose(): void;
}

// -- 时间线 -------------------------------------------------------------------

/** 标题落下。 */
const TITLE_AT = 300;
const TITLE_MS = 900;
/** 左框自绘：四条边顺时针依次画一圈。 */
const FRAME_AT = 900;
const FRAME_MS = 1050;
/** 描完之后「框变成牌」：卡面淡入。 */
const FILL_AT = 1900;
const FILL_MS = 320;
/** 牌堆展开：五张牌从叠着的初始位置散成扇形。 */
const CARDS_AT = 2150;
const CARDS_MS = 1150;
/** 右框自绘。 */
const RFRAME_AT = 2750;
const RFRAME_MS = 900;
/** 右框浅绿填充 + 粒子团淡入。 */
const RFILL_AT = 3610;
const RFILL_MS = 640;
/** 提示语浮出。 */
const HINT_AT = 4100;
const HINT_MS = 600;
/** 时间线收尾余量。 */
const TAIL = 800;

const TIMELINE_END = HINT_AT + HINT_MS + TAIL;

// -- 扇形与抽出参数 -----------------------------------------------------------

/** 每张牌相对中心的旋转角（度）。外围牌转得更多，扇面就打开。 */
const FAN_SPREAD_DEG = 7.2;
/** 抽出距离 = 牌宽 × 这个比例。拉到足够远，被选中的牌才不会被扇面挡住。 */
const EXTRACT_RATIO = 0.58;
/** 抽出时略微上抬（px）。 */
const EXTRACT_LIFT = 24;
/** 抽出时略微放大，强化“被拿到手里”的感觉。 */
const EXTRACT_SCALE = 1.035;

/** 放下后需离开释放点这么多像素才恢复 hover 选中，用于吃掉点击瞬间的手抖位移。 */
const RELEASE_SLOP_PX = 8;
const RELEASE_SLOP_SQ = RELEASE_SLOP_PX * RELEASE_SLOP_PX;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const span = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from));
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number): number => t * t;

// -- 圆角自绘描边 -------------------------------------------------------------

/**
 * 每个框用一张内联 SVG 描边：一个带 `rx` 的 `<rect>`，`stroke-dasharray` 取周长，
 * `stroke-dashoffset` 由「周长 → 0」，笔画就从左上角顺时针长出来
 * （上 → 右 → 下 → 左，与旧的四条边顺序一致）。圆角是路径自带的属性，所以**动画
 * 过程中画出来的角本身就是圆的**，不用事后再补。
 *
 * 不设 `viewBox`（宽高都是 100%），用户单位 = CSS px，1:1。几何与周长都在这里解析
 * 算出来，不依赖 `getTotalLength()`。
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 描边线宽（px）。 */
const FRAME_STROKE = 2;
/** 读不到 `--frame-radius` 时的兜底圆角。 */
const FALLBACK_RADIUS = 12;

interface FrameOutline {
  frame: HTMLElement;
  rect: SVGRectElement;
  /** 时间线写入的进度；尺寸还没量到时先记着，量到后再补画。 */
  progress: number;
  /** 路径周长；0 表示还没量到尺寸。 */
  perimeter: number;
}

/** 圆角半径从 CSS 的 `--frame-radius` 读，保证「一处旋钮」。 */
const readRadius = (frame: HTMLElement): number => {
  const value = Number.parseFloat(getComputedStyle(frame).getPropertyValue('--frame-radius'));
  return Number.isFinite(value) && value >= 0 ? value : FALLBACK_RADIUS;
};

/** 按记住的进度写 `stroke-dashoffset`。还没量到尺寸时什么都不写。 */
const applyOutline = (outline: FrameOutline): void => {
  if (!outline.perimeter) return;
  const hidden = outline.perimeter * (1 - clamp01(outline.progress));
  outline.rect.style.strokeDashoffset = hidden.toFixed(3);
};

/**
 * 量尺寸 → 写 rect 几何 + 周长 → 把记住的进度补画上去。这是**唯一**的布局读点，
 * 只在构建 / resize 时调用。尺寸为 0（还没布局）时直接返回，等下一次。
 */
const sizeOutline = (outline: FrameOutline, width?: number, height?: number): void => {
  const boxW = width ?? outline.frame.clientWidth;
  const boxH = height ?? outline.frame.clientHeight;
  if (boxW <= 0 || boxH <= 0) return;

  // 笔画居中于路径：路径内缩半个线宽后，笔画的外沿正好落在框边上。
  const inset = FRAME_STROKE / 2;
  const w = boxW - FRAME_STROKE;
  const h = boxH - FRAME_STROKE;
  // 外圆角 = rx + inset，让它等于 CSS 的 border-radius。
  const rx = Math.max(0, readRadius(outline.frame) - inset);

  const rect = outline.rect;
  rect.setAttribute('x', String(inset));
  rect.setAttribute('y', String(inset));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  rect.setAttribute('rx', String(rx));
  rect.setAttribute('stroke-width', String(FRAME_STROKE));

  // 圆角矩形周长 = 直边总和 + 四个 1/4 圆弧（正好合成一个整圆）。
  outline.perimeter = 2 * (w + h) - 2 * rx * (4 - Math.PI);
  rect.style.strokeDasharray = `${outline.perimeter}`;
  applyOutline(outline);
};

const makeOutline = (frame: HTMLElement): FrameOutline => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'skills__frame-outline');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('aria-hidden', 'true');

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'skills__frame-stroke');
  rect.setAttribute('fill', 'none');
  svg.append(rect);
  frame.append(svg);

  return { frame, rect, progress: 0, perimeter: 0 };
};

/** 每帧调用：只记进度 + 一次样式写，不做任何布局读。 */
const drawFrame = (outline: FrameOutline, progress: number): void => {
  outline.progress = clamp01(progress);
  applyOutline(outline);
};

export function createSkillsSection(options: SkillsSectionOptions = {}): SkillsSectionHandle {
  if (typeof document === 'undefined') {
    throw new Error('createSkillsSection requires a DOM');
  }

  const titleText = options.title ?? SKILLS_TITLE;
  const cardCount = options.cardCount ?? SKILLS_CARD_COUNT;
  const reduced = prefersReducedMotion();

  const section = document.createElement('section');
  section.className = 'skills';
  section.id = 'works';

  const sticky = document.createElement('div');
  sticky.className = 'skills__sticky';

  const panel = document.createElement('div');
  panel.className = 'skills__panel';

  // -- 标题 --------------------------------------------------------------------

  const title = document.createElement('h2');
  title.className = 'skills__title';
  // 不设 textContent：正文由下面的 span 承载，不然原始文本会和逐字 span 一起
  // 渲染，标题会显示两遍。
  title.setAttribute('aria-label', titleText);

  const titleGlyphs: HTMLElement[] = [];
  for (const char of titleText) {
    const glyph = document.createElement('span');
    glyph.className = 'skills__title-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = char;
    titleGlyphs.push(glyph);
    title.append(glyph);
  }

  // -- 左侧：一张画出来的牌 → 五张扇形牌 ----------------------------------------

  const stage = document.createElement('div');
  stage.className = 'skills__stage';

  const cardsPanel = document.createElement('div');
  cardsPanel.className = 'skills__panel-side skills__panel-side--cards';

  // 左框：一张被「画」出来的牌。描边由一张 SVG 圆角矩形自己长出来，静态时长度为 0，
  // 所以描边开始之前完全看不出边界在哪里。
  const cardsFrame = document.createElement('div');
  cardsFrame.className = 'skills__frame skills__frame--cards';

  const cardsSkin = document.createElement('div');
  cardsSkin.className = 'skills__frame-skin';

  cardsFrame.append(cardsSkin);
  const cardsOutline = makeOutline(cardsFrame);

  // 牌堆：和框完全重叠（同样的定位与尺寸），所以叠着的时候看不出还有四张。
  const deck = document.createElement('div');
  deck.className = 'skills__deck';

  // 胶囊的「幽灵层」：和牌同尺寸、同支点，transform 由 writeGhost 写成和牌一模一样的
  // 那一串，所以永远严丝合缝地压在牌上——胶囊因此自动跟着牌的抽出 / 缩放 / 变尺寸走，
  // 不必再单独算位置。
  //
  // 为什么不做成卡片的子节点：卡片是 `role="button" tabindex="0"`，里面再塞一个
  // `<button>` 属于交互元素嵌套（屏幕阅读器可能整个不播报），而且卡片在扇面展开前是
  // `aria-hidden="true"`，按钮会被一起藏掉。所以让它是 deck 的兄弟，排在五张牌之后，
  // Tab 顺序自然落在卡后面。
  const capsuleGhost = document.createElement('div');
  capsuleGhost.className = 'skills__capsule-ghost';

  const capsule = document.createElement('button');
  capsule.type = 'button';
  capsule.className = 'skills__capsule';
  capsule.textContent = SKILLS_RELEASE_TEXT;
  capsule.setAttribute('aria-label', SKILLS_RELEASE_LABEL);
  // 没显示时移出 Tab 顺序（配合 CSS 的 visibility: hidden）。
  capsule.tabIndex = -1;

  capsuleGhost.append(capsule);

  interface CardAnim {
    /** 0 = 全部叠在初始位置；1 = 展开成扇形。 */
    progress: number;
    /** 0 = 归位；1 = 被抽出。 */
    extract: number;
    /** 这张牌在扇面上的角度（度）。 */
    angle: number;
  }

  const cards: HTMLElement[] = [];
  const anims: CardAnim[] = [];
  const centre = (cardCount - 1) / 2;
  /** 牌的旋转支点相对牌顶的位置（与样式里的 `transform-origin: 50% 118%` 一致）。 */
  const CARD_PIVOT_RATIO = 1.18;
  /** 牌宽（px），用于把抽出距离换算成比例。 */
  let cardW = 248;
  /** 当前选中的牌，-1 表示没有。 */
  let selected = -1;
  /** 被「钉住」的牌，-1 表示没有。钉住期间恒有 selected === pinned。 */
  let pinned = -1;
  /**
   * 放下之后抑制 hover 选中，直到指针离开释放点超过 RELEASE_SLOP_PX。
   *
   * 为什么需要：胶囊贴在**抽出位**那张牌的右下角，放下后牌转回扇面，指针原地这点
   * 已落进**邻牌**里（该点同时落在全部五张牌的静止包围盒内，`hitCardAt` 取 z 最高的
   * 那张，会命中 card 4）；若无守卫，放下后的第一次 pointermove 就弹出旁边一张牌。
   *
   * 为什么按「离释放点的位移」而不是「离开整个面板」：容器很大，早先那版只在
   * `pointerleave` 清除，于是放下后必须先绕出整个左栏再回来才能继续交互。
   *
   * 释放点只认「指针按下」这一路：键盘触发（Enter / Space）不会产生 `pointerdown`，
   * 于是自然拿到 NaN、不置位——那一刻指针本来也没悬在牌上，不存在误弹。
   */
  let hoverSuppressed = false;
  let releaseX = 0;
  let releaseY = 0;

  /** 某张牌此刻的 transform。牌与胶囊幽灵层共用，两者才永远重合。 */
  const transformFor = (index: number): string => {
    const anim = anims[index];
    const e = anim.extract;
    // 抽出时把扇形角度抵消掉，牌会自己转正到水平，方便看清内容。
    const angle = anim.angle * (anim.progress - e);
    const tx = -e * cardW * EXTRACT_RATIO;
    const ty = -e * EXTRACT_LIFT;
    const scale = 1 + (EXTRACT_SCALE - 1) * e;
    return (
      `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) ` +
      `rotate(${angle.toFixed(3)}deg) scale(${scale.toFixed(4)})`
    );
  };

  /** 让胶囊幽灵层跟到某张牌上。牌被抽出时 z 是 cardCount + 10，胶囊再高一层。 */
  const writeGhost = (index: number): void => {
    capsuleGhost.style.transform = transformFor(index);
    capsuleGhost.style.zIndex = String(cardCount + 11);
  };

  const writeCard = (index: number): void => {
    const card = cards[index];
    const extract = anims[index].extract;
    card.style.transform = transformFor(index);
    card.style.zIndex = String(extract > 0.5 ? cardCount + 10 : index + 1);
    // 钉住的那张牌动了（resize、或刚钉住）胶囊要跟上。
    if (index === pinned) writeGhost(index);
  };

  /** 选中一张牌：它抽出并转正，其余归位。传 -1 表示全部归位。 */
  const select = (index: number): void => {
    if (selected === index) return;
    selected = index;
    for (let i = 0; i < cardCount; i += 1) {
      const want = i === index ? 1 : 0;
      cards[i].classList.toggle('is-picked', i === index);
      if (anims[i].extract !== want) {
        anims[i].extract = want;
        writeCard(i);
      }
    }
    // 右栏跟着走：选中有对比图的卡就换成三图，否则退回粒子团。
    syncRightPanel();
  };

  const showCapsule = (): void => {
    if (pinned < 0) return;
    // 先定位再显形：幽灵层没有 transform 过渡（见 styles.css），这一步是瞬时的。
    writeGhost(pinned);
    capsuleGhost.classList.add('is-shown');
    capsule.tabIndex = 0;
  };

  const hideCapsule = (): void => {
    capsuleGhost.classList.remove('is-shown');
    capsule.tabIndex = -1;
  };

  /**
   * 钉住一张牌：它一直悬在抽出位，直到点胶囊放下。
   *
   * 钉住期间整个板块**冻结**——hover、点击别的牌、Tab 到别的牌都不生效，
   * 唯一出口是胶囊。所以这里一进来就先挡住「已经钉着」的情况。
   */
  const pin = (index: number): void => {
    if (pinned >= 0) return;
    if (index < 0 || index >= cardCount) return;
    // 入场还没播完（右框还在自绘，牌也还没散开）不接受点击。
    if (!introDone && !reduced) return;
    // 触摸没有 hover，单点也要先选中；桌面下通常已经是它了，select 会自己早退。
    select(index);
    pinned = index;
    hoverSuppressed = false;
    showCapsule();
  };

  /**
   * 放下被钉住的牌：归位、收起胶囊、右栏退回粒子团。
   *
   * `x` / `y` 是触发放下时指针的位置；键盘激活没有真实坐标，传 NaN 即可。
   */
  const release = (x: number, y: number): void => {
    if (pinned < 0) return;
    pinned = -1;
    hideCapsule();
    // 必须赶在 select(-1) 之前置位：放下后指针还压在牌原来的位置上。
    if (Number.isFinite(x) && Number.isFinite(y)) {
      hoverSuppressed = true;
      releaseX = x;
      releaseY = y;
    }
    select(-1);
  };

  /**
   * 命中判定用的是牌在扇面上的**静止位置**，而不是它抽出之后的位置——否则牌
   * 一抽走就可能从指针下滑开，pointerleave → 收回 → 又命中，来回抖。
   *
   * 唯一例外是被选中那张：它的「抽出位」也算命中区，这样指针跟着牌一起挪
   * 过去时不会把它甩掉（一点滞回）。
   *
   * 判定方式：把指针坐标反变换回牌的局部坐标（绕支点反向旋转 + 反缩放平移），
   * 再和矩形做包围盒比较。从 z 最高的牌开始试，先命中的胜出。
   */
  const hitCardAt = (clientX: number, clientY: number): number => {
    const box = deck.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    if (w <= 0 || h <= 0) return -1;
    const ox = w / 2;
    const oy = h * CARD_PIVOT_RATIO;
    const px = clientX - box.left;
    const py = clientY - box.top;

    const inside = (angle: number, tx: number, ty: number, scale: number): boolean => {
      const rad = (-angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const qx = (px - ox - tx) / scale;
      const qy = (py - oy - ty) / scale;
      const lx = qx * cos - qy * sin + ox;
      const ly = qx * sin + qy * cos + oy;
      return lx >= 0 && lx <= w && ly >= 0 && ly <= h;
    };

    for (let index = cardCount - 1; index >= 0; index -= 1) {
      const anim = anims[index];
      if (anim.progress < 0.75) continue;
      if (inside(anim.angle * anim.progress, 0, 0, 1)) return index;
    }

    if (selected >= 0) {
      const anim = anims[selected];
      const e = anim.extract;
      const holds = inside(
        anim.angle * anim.progress * (1 - e),
        -w * EXTRACT_RATIO * e,
        -EXTRACT_LIFT * e,
        1 + (EXTRACT_SCALE - 1) * e,
      );
      if (holds) return selected;
    }
    return -1;
  };

  for (let index = 0; index < cardCount; index += 1) {
    const content = SKILLS_CARDS[index];
    const card = document.createElement('div');
    card.className = 'skills__card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute(
      'aria-label',
      content?.title ? `技能卡片：${content.title}` : `技能卡片 ${index + 1}（内容待定）`,
    );
    // 右压左：DOM 顺序已决定层叠，这里显式给一个 z（抽出的牌会被抬到最上层）。
    card.style.zIndex = String(index + 1);

    const face = document.createElement('div');
    face.className = 'skills__card-face';

    // 卡面内容：大标题 + 一道短线 + 说明小字。空卡（没有 title）保持空白牌面。
    if (content?.title) {
      const body = document.createElement('div');
      body.className = 'skills__card-body';

      const cardTitle = document.createElement('h3');
      cardTitle.className = 'skills__card-title';
      cardTitle.textContent = content.title;

      const rule = document.createElement('span');
      rule.className = 'skills__card-rule';
      rule.setAttribute('aria-hidden', 'true');

      body.append(cardTitle, rule);

      if (content.blurb) {
        const blurb = document.createElement('p');
        blurb.className = 'skills__card-blurb';
        blurb.textContent = content.blurb;
        body.append(blurb);
      }
      face.append(body);
    }

    card.append(face);

    const anim: CardAnim = { progress: 0, extract: 0, angle: (index - centre) * FAN_SPREAD_DEG };
    anims.push(anim);
    cards.push(card);
    deck.append(card);

    // 指针命中统一由牌堆容器负责（见下面的 onCardsPointerMove）；这里只管键盘。
    card.addEventListener('focus', () => {
      // 钉住期间连 Tab 也不改画面，出口只有胶囊。
      if (pinned >= 0) return;
      if (anim.progress >= 0.75) select(index);
    });
    card.addEventListener('blur', () => {
      // 点胶囊会让卡片失焦，这里若照旧收回，牌会在放下的同时被抖一下。
      if (pinned >= 0) return;
      select(-1);
    });
    // 键盘等价于点击：Enter / Space 钉住，再按一次放下。
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); // Space 默认会滚页
      if (pinned === index) release(Number.NaN, Number.NaN);
      else pin(index);
    });
  }

  // 幽灵层排在五张牌之后，Tab 顺序自然落在卡片后面。
  deck.append(capsuleGhost);

  const onCardsPointerMove = (event: PointerEvent): void => {
    if (pinned >= 0) return;
    if (hoverSuppressed) {
      // 平方距离比较，别在 pointermove 这种高频回调里调 hypot。
      const dx = event.clientX - releaseX;
      const dy = event.clientY - releaseY;
      if (dx * dx + dy * dy < RELEASE_SLOP_SQ) return;
      hoverSuppressed = false;
    }
    select(hitCardAt(event.clientX, event.clientY));
  };
  const onCardsPointerLeave = (): void => {
    if (pinned >= 0) return;
    hoverSuppressed = false; // 兜底：指针真的离开面板 / 窗口失焦
    select(-1);
  };
  // 点击牌 = 钉住。卡片是 pointer-events: none，所以 click 落在容器上，坐标现算。
  const onCardsClick = (event: MouseEvent): void => {
    pin(hitCardAt(event.clientX, event.clientY));
  };
  cardsPanel.addEventListener('pointermove', onCardsPointerMove, { passive: true });
  cardsPanel.addEventListener('pointerleave', onCardsPointerLeave);
  cardsPanel.addEventListener('click', onCardsClick);

  // 胶囊就压在卡片命中区里，必须拦住冒泡，否则容器会立刻把它重新钉住。
  //
  // 释放点只在 **pointerdown** 记录：键盘（Enter / Space）激活按钮不会触发
  // pointerdown，于是自然拿到 NaN，不会把守卫锚到键盘上。比 event.detail > 0 稳。
  let capsuleDownX = Number.NaN;
  let capsuleDownY = Number.NaN;
  capsule.addEventListener('pointerdown', (event) => {
    capsuleDownX = event.clientX;
    capsuleDownY = event.clientY;
  });
  capsule.addEventListener('pointercancel', () => {
    capsuleDownX = Number.NaN;
    capsuleDownY = Number.NaN;
  });
  capsule.addEventListener('click', (event) => {
    event.stopPropagation();
    release(capsuleDownX, capsuleDownY);
    capsuleDownX = Number.NaN;
    capsuleDownY = Number.NaN;
  });

  cardsPanel.append(cardsFrame, deck);

  // -- 右侧：线框 + 粒子团 ------------------------------------------------------

  const swarmPanel = document.createElement('div');
  swarmPanel.className = 'skills__panel-side skills__panel-side--swarm';

  const swarmFrame = document.createElement('div');
  swarmFrame.className = 'skills__frame skills__frame--swarm';

  const swarmFillLayer = document.createElement('div');
  swarmFillLayer.className = 'skills__swarm-fill';

  const swarmCanvasHost = document.createElement('div');
  swarmCanvasHost.className = 'skills__swarm-canvas-host';

  const pick = document.createElement('div');
  pick.className = 'skills__pick';

  const pickTitle = document.createElement('p');
  pickTitle.className = 'skills__pick-title';
  pickTitle.textContent = SKILLS_PICK_HINT;

  const pickSub = document.createElement('p');
  pickSub.className = 'skills__pick-sub';
  pickSub.textContent = SKILLS_PICK_SUB;

  pick.append(pickTitle, pickSub);
  swarmFrame.append(swarmFillLayer, swarmCanvasHost);
  const swarmOutline = makeOutline(swarmFrame);
  swarmPanel.append(swarmFrame, pick);

  stage.append(cardsPanel, swarmPanel);

  // -- 背景光球 ----------------------------------------------------------------

  const orbHost = document.createElement('div');
  orbHost.className = 'skills__orb-host';
  orbHost.setAttribute('aria-hidden', 'true');

  panel.append(title, stage);
  sticky.append(panel);
  section.append(orbHost, sticky);

  // -- 状态 --------------------------------------------------------------------

  let orbField: OrbFieldHandle | null = null;
  let swarmField: SwarmFieldHandle | null = null;
  /**
   * 右栏场景句柄缓存：scene id → handle。粒子团不在其中（它是否可见，由
   * `activeSceneId` 是否为 null 决定）。`compare` 在 `buildEffects()` 里预载登记，
   * 其余场景惰性创建——首次被选中时才建，省掉用不到的开销。
   */
  const sceneHandles = new Map<string, SkillSceneHandle>();
  /** 右栏当前激活的场景 id；null = 粒子团。 */
  let activeSceneId: string | null = null;
  /** 正在展示场景的卡号，-1 表示没有。 */
  let activeSceneCard = -1;

  let timeline = 0;
  let scrollFrame = 0;
  let introFrame = 0;
  let introStart = 0;
  let introDone = false;
  let holding = false;
  let lockedScrollY = 0;
  let disposed = false;
  let lastPhase: 'idle' | 'pinned' | 'leaving' | null = null;
  let sinkValue = 0;

  const lockRoot = document.body;

  /** 卡 → 场景 id：`scene` 优先，其次 `compare`（≥2 层），否则 null（粒子团）。 */
  const sceneKindFor = (content: SkillCardContent | undefined): string | null => {
    if (content?.scene) return content.scene;
    const layers = content?.compare?.layers;
    return layers && layers.length >= 2 ? 'compare' : null;
  };

  /** 按需创建并缓存场景句柄；未知 id 回退为 inert（存在但不显示、不吃事件）。 */
  const ensureScene = (id: string, content: SkillCardContent): SkillSceneHandle => {
    const cached = sceneHandles.get(id);
    if (cached) return cached;
    const factory = SKILL_SCENE_FACTORIES[id];
    const handle = factory ? factory(swarmFrame, content) : inertSkillScene();
    handle.hide();
    sceneHandles.set(id, handle);
    return handle;
  };

  /**
   * 右栏场景切换：粒子团 ↔ 任意场景。
   *
   * crossfade 必须在这里（命令式）写——`.skills__swarm-canvas-host` 的 `opacity`
   * 是时间线每帧写入的**行内样式**，class 规则覆盖不了它；各场景的透明度也走同一条
   * 路，过渡由 CSS 在 `.is-settled` 之后打开。
   */
  const setRightPanel = (sceneId: string | null): void => {
    activeSceneId = sceneId;
    swarmCanvasHost.style.opacity = sceneId ? '0' : '1';
    for (const [id, handle] of sceneHandles) {
      if (id === sceneId) handle.show();
      else handle.hide();
    }
  };

  /** 让右栏追上当前选中的卡。选中变化时、以及 intro 结束那一刻都会调。 */
  const syncRightPanel = (): void => {
    // 入场还没播完就别抢画面：右框此刻还在自绘描边 / 填充。
    if (!introDone && !reduced) return;

    const content = selected >= 0 ? SKILLS_CARDS[selected] : undefined;
    const kind = sceneKindFor(content);

    if (kind && content) {
      // 同一张卡、同一个场景 → 不重播（`select` 已对同 index 早退，这里再兜一层）。
      if (kind === activeSceneId && selected === activeSceneCard) return;
      const handle = ensureScene(kind, content);
      // 切走的场景停掉脚本，免得它的 rAF 在背后空转。
      for (const [id, other] of sceneHandles) {
        if (id !== kind) other.cancel();
      }
      setRightPanel(kind);
      handle.play(content);
      activeSceneCard = selected;
      return;
    }

    // 没有场景：退回粒子团。
    if (activeSceneId !== null) {
      for (const [, other] of sceneHandles) other.cancel();
      setRightPanel(null);
      activeSceneCard = -1;
    }
  };

  const measure = (): void => {
    const width = deck.offsetWidth;
    if (width > 0) cardW = width;
  };

  const applyLock = (): void => {
    if (holding) {
      if (reduced || lockRoot.classList.contains('is-skills-locked')) return;
      lockedScrollY = window.scrollY;
      lockRoot.style.top = `${-lockedScrollY}px`;
      lockRoot.classList.add('is-skills-locked');
      return;
    }
    if (lockRoot.classList.contains('is-skills-locked')) {
      lockRoot.classList.remove('is-skills-locked');
      lockRoot.style.top = '';
      window.scrollTo(0, lockedScrollY);
    }
  };

  const setTimeline = (value: number): void => {
    timeline = Math.min(TIMELINE_END, Math.max(0, value));

    // 标题：整块从上方落下，逐字再补一点错峰。
    const t = span(timeline, TITLE_AT, TITLE_AT + TITLE_MS);
    const drop = 1 - easeOut(t);
    title.style.setProperty('--title-drop', `${(drop * 62).toFixed(2)}vh`);
    title.style.setProperty('--title-fade', (0.15 + 0.85 * t).toFixed(4));
    const perGlyph = 1 / Math.max(1, titleGlyphs.length);
    titleGlyphs.forEach((glyph, index) => {
      const delay = index * perGlyph * 0.5;
      const local = clamp01((t - delay) / Math.max(0.3, 1 - delay));
      glyph.style.setProperty('--glyph-lift', `${((1 - easeOut(local)) * 0.8).toFixed(2)}rem`);
    });

    // 左框：先自绘描边（上 → 右 → 下 → 左，圆角一路画出来），描完卡面淡入——框变成一张牌。
    const frameProgress = span(timeline, FRAME_AT, FRAME_AT + FRAME_MS);
    drawFrame(cardsOutline, frameProgress);
    cardsFrame.style.setProperty('--frame-fill', easeOut(span(timeline, FILL_AT, FILL_AT + FILL_MS)).toFixed(4));

    // 牌堆出现（此刻五张牌仍完全叠在框的位置，看起来就是刚才那张牌），
    // 框随后退场；两者交错淡换，视觉上就是「框化成了牌」。
    deck.style.opacity = span(timeline, CARDS_AT - 140, CARDS_AT + 140).toFixed(4);
    cardsFrame.style.opacity = (1 - easeOut(span(timeline, CARDS_AT - 80, CARDS_AT + 300))).toFixed(4);

    // 牌堆展开：从左到右依次散开，每张自己缓出。
    const fan = span(timeline, CARDS_AT, CARDS_AT + CARDS_MS);
    anims.forEach((anim, index) => {
      const delay = index * 0.1;
      const local = clamp01((fan - delay) / Math.max(0.42, 1 - delay));
      anim.progress = easeOut(local);
      const card = cards[index];
      card.setAttribute('aria-hidden', anim.progress > 0.75 ? 'false' : 'true');
      writeCard(index);
    });

    // 右框：自绘圆角描边 → 与背景同色的填充 + 粒子团淡入。
    drawFrame(swarmOutline, span(timeline, RFRAME_AT, RFRAME_AT + RFRAME_MS));
    const fillT = easeOut(span(timeline, RFILL_AT, RFILL_AT + RFILL_MS));
    swarmFillLayer.style.setProperty('--frame-fill', fillT.toFixed(4));
    swarmCanvasHost.style.opacity = fillT.toFixed(4);

    // 提示语。
    pick.style.setProperty('--hint-in', easeOut(span(timeline, HINT_AT, HINT_AT + HINT_MS)).toFixed(4));

    // 时间线跑完才打开 CSS 补间，之后抽出 / 收回才是丝滑的过渡。
    section.classList.toggle('is-settled', timeline >= TIMELINE_END - 1);
  };

  // -- 滚动：只负责钉住 / 放行 / 下沉 -------------------------------------------

  const update = (): void => {
    scrollFrame = 0;
    const rect = section.getBoundingClientRect();
    if (rect.height === 0) return;

    if (reduced) {
      sinkValue = 0;
      section.style.setProperty('--act-sink', '0');
      return;
    }

    if (rect.top <= 0 && enterPlay()) return;

    const runway = section.offsetHeight - window.innerHeight;
    const p = runway > 0 ? clamp01((window.scrollY - section.offsetTop) / runway) : 0;
    const sink = introDone ? easeIn(span(p, 0.45, 1)) : 0;
    sinkValue = sink;
    section.style.setProperty('--act-sink', sink.toFixed(4));

    // 下沉时把光球一起收掉，交还后面的内容。
    if (sinkValue > 0.5) section.classList.add('is-retiring');

    const phase: 'idle' | 'pinned' | 'leaving' =
      rect.top > 0 ? 'idle' : rect.bottom <= window.innerHeight + 1 ? 'leaving' : 'pinned';
    if (phase !== lastPhase) {
      lastPhase = phase;
      section.classList.toggle('is-pinned', phase === 'pinned');
    }
  };

  const onScroll = (): void => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(update);
  };

  const onResize = (): void => {
    measure();
    // ResizeObserver 不可用时的兜底（正常路径由下面那个 observer 用分数尺寸量）。
    sizeOutline(cardsOutline);
    sizeOutline(swarmOutline);
    anims.forEach((_, index) => writeCard(index));
    onScroll();
  };

  const enterPlay = (): boolean => {
    if (holding || introDone || reduced || section.offsetHeight === 0) return false;
    window.scrollTo(0, section.offsetTop);
    holding = true;
    applyLock();
    startIntro();
    update();
    return true;
  };

  const exitPlay = (): void => {
    if (!holding) return;
    holding = false;
    update();
    applyLock();
  };

  const introStep = (now: number): void => {
    if (disposed || introDone) return;
    const elapsed = now - introStart;
    if (elapsed > timeline) setTimeline(elapsed);
    if (elapsed >= TIMELINE_END) {
      introDone = true;
      introFrame = 0;
      // 入场期间右框还在自绘，对比切换被 gate 掉了；播完补一次，避免漏掉
      // 「刚开场就用键盘选中了卡 0」这种场景。
      syncRightPanel();
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

  // -- 指针：喂给粒子团 ---------------------------------------------------------

  const onPointerMove = (event: PointerEvent): void => {
    // 右栏正在展示场景（对比图 / 灯泡…）时粒子团被淡出了，没必要再喂指针。
    if (!swarmField || activeSceneId !== null) return;
    const rect = swarmFrame.getBoundingClientRect();
    const pad = 140;
    const inside =
      event.clientX > rect.left - pad &&
      event.clientX < rect.right + pad &&
      event.clientY > rect.top - pad &&
      event.clientY < rect.bottom + pad;
    if (inside) swarmField.setPointer(event.clientX, event.clientY, true);
    else swarmField.setPointer(-1e4, -1e4, false);
  };

  const onPointerLeave = (): void => {
    swarmField?.setPointer(-1e4, -1e4, false);
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);

  const entrance = new IntersectionObserver(
    () => {
      const rect = section.getBoundingClientRect();
      if (rect.top <= 0) enterPlay();
    },
    { threshold: [0, 0.3, 0.6, 1] },
  );
  entrance.observe(section);

  // 描边的几何尺寸跟着两个框走。用 `contentRect`（分数像素）而不是
  // `getBoundingClientRect()`——`.skills__sticky` 上有 translateY + scale，前者不受
  // transform 影响；`clientWidth` 则会把 371.8 取整成 372。
  const outlineResize =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (entry.target === cardsFrame) sizeOutline(cardsOutline, width, height);
            else if (entry.target === swarmFrame) sizeOutline(swarmOutline, width, height);
          }
        });
  outlineResize?.observe(cardsFrame);
  outlineResize?.observe(swarmFrame);

  // -- 效果构建 ---------------------------------------------------------------

  const buildEffects = async (): Promise<void> => {
    while (!disposed && section.offsetHeight === 0) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    if (disposed) return;

    // 多图对比组件：两种动效档都要建（它不做入场动画的早退，只把扫动降级）。
    // 预载第一张卡的图层——首次 hover 时才换图的话会赶上解码、闪一下。
    // 包成 `SkillSceneHandle` 登记进场景表，右栏的切换逻辑就可以一视同仁。
    const compare = createImageCompare({
      host: swarmFrame,
      layers: SKILLS_CARDS[0]?.compare?.layers ?? [],
    });
    sceneHandles.set('compare', {
      element: compare.element,
      show: () => compare.show(),
      hide: () => compare.hide(),
      play: (content) => {
        const layers = content.compare?.layers;
        if (layers && layers.length >= 2) {
          compare.setLayers(layers);
          compare.playSweep();
        }
      },
      cancel: () => compare.cancelSweep(),
      dispose: () => compare.dispose(),
    });

    if (reduced) {
      section.classList.add('is-reduced');
      title.style.setProperty('--title-drop', '0vh');
      title.style.setProperty('--title-fade', '1');
      titleGlyphs.forEach((glyph) => glyph.style.setProperty('--glyph-lift', '0rem'));
      sizeOutline(cardsOutline);
      sizeOutline(swarmOutline);
      drawFrame(cardsOutline, 1);
      drawFrame(swarmOutline, 1);
      swarmFillLayer.style.setProperty('--frame-fill', '1');
      swarmCanvasHost.style.opacity = '1';
      pick.style.setProperty('--hint-in', '1');
      // 静态呈现：框收起，牌堆直接摆成完整的扇形（抽出用的监听照常可用）。
      cardsFrame.style.opacity = '0';
      deck.style.opacity = '1';
      anims.forEach((anim, index) => {
        anim.progress = 1;
        anim.extract = 0;
        cards[index].setAttribute('aria-hidden', 'false');
        writeCard(index);
      });
      // 静态呈现时不跑粒子循环，只保留背景与卡牌。
      return;
    }

    measure();
    sizeOutline(cardsOutline);
    sizeOutline(swarmOutline);
    // 背景光球画成白色（页面上安静的浅色高光）；右框里的粒子团保持品牌绿，
    // 在「和背景同色」的浅底上才读得出来。
    orbField = createOrbField({ host: orbHost, fixed: false, tone: 'white' });
    // 右框拉成 16:9 后宿主短边变小，把牌面占比调大一点，粒子团的分量才不至于缩水。
    swarmField = createSwarmField({ host: swarmCanvasHost, cardFill: 0.55 });

    setTimeline(timeline);

    const rect = section.getBoundingClientRect();
    if (rect.top <= 0) enterPlay();
  };

  if (reduced) {
    section.classList.add('is-reduced');
  }
  void buildEffects();
  update();

  return {
    element: section,
    dispose: () => {
      disposed = true;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      cardsPanel.removeEventListener('pointermove', onCardsPointerMove);
      cardsPanel.removeEventListener('pointerleave', onCardsPointerLeave);
      cardsPanel.removeEventListener('click', onCardsClick);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      if (introFrame) window.cancelAnimationFrame(introFrame);
      if (lockRoot.classList.contains('is-skills-locked')) {
        lockRoot.classList.remove('is-skills-locked');
        lockRoot.style.top = '';
      }
      entrance.disconnect();
      outlineResize?.disconnect();
      orbField?.dispose();
      swarmField?.dispose();
      // 场景句柄（含 compare 适配器）各自负责自己的卸载。
      for (const [, handle] of sceneHandles) handle.dispose();
      sceneHandles.clear();
    },
  };
}
