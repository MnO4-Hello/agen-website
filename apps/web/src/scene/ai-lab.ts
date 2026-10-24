/**
 * 右栏场景：左边一段「AI 对话模拟」，右边一块「由字符拼成的 AI 图标」。
 *
 * 定位：`SkillSceneHandle` 契约下的一个场景（见 scene/skill-scene.ts），由
 * `sections/skills.ts` 在「AI 创意生产」卡被选中时挂进 `.skills__frame--swarm`，
 * 替换默认的粒子团。
 *
 * 右栏的做法照搬 https://www.bilibili.com/toy/wujisuan-ai-test/ ：
 *   - 每个品牌 logo 在运行时栅格化成蒙版（scene/ai-icons.ts），按格子采样成一堆
 *     字符（大面积是品牌首字母，边缘换 `+`，零星 `#` / `*` 点缀）；
 *   - 每隔一两秒整块**就近归位**地变成下一个 logo：每颗字符各自认领一个最近的目标
 *     位，按目标 x 从左到右错峰起步、路径带一点弧高，所以看起来是一道从左扫过去
 *     的波，而不是整块平移；
 *   - 字符还会被涟漪推开：**只有**鼠标扫进右栏时，才以指针为中心向外荡开一圈波。
 *     指针不在时画面是静的（只保留 logo 之间那道形变波），不做任何自动波纹。
 *
 * 三条纪律（与 ps-bulb.ts / code-typing.ts / image-compare.ts 一致）：
 *
 *   1. **逐帧不读布局**：左栏只往一个 Text 节点追加字符、右栏只往 canvas 上画，尺寸
 *      只在构造与 ResizeObserver 回调里量。指针坐标走 `offsetX / offsetY`，同样不读
 *      rect——`.skills__sticky` 上有 translateY + scale，缓存的 rect 会失效。
 *      追加气泡时那一次 `scrollHeight` 是有意的例外（每轮才一次，不是每帧）。
 *   2. **不给逐帧写入的东西挂 CSS 过渡**：根元素默认没有 transition，淡换只在
 *      `.skills.is-settled .ai-lab` 之后才由 CSS 打开——否则入场期间每帧写的
 *      `opacity` 会和过渡打架（和 `.skills__card` 的 `transition: none` 同一条纪律）。
 *   3. **reduced-motion 不早退**：照常建 DOM，只把脚本落到终态——左栏直接摆出
 *      一轮完整的问答，右栏把字符一次摆到第一个图标上、画一帧后不启 rAF，涟漪也
 *      不接指针事件（没有 rAF 就不会有涟漪）。
 *
 * 两条循环各自独立：
 *   - 左栏：`typing → sending → thinking → replying → holding` 无限循环 10 组问答；
 *   - 右栏：`dwell → morph → dwell …` 在 6 个 logo 之间无限循环。
 * 两者共用**同一个 rAF**（`step`），所以 `cancel()` 一停就全停，没有第二个定时器。
 */

import { prefersReducedMotion, whenFontsReady } from './text-support';
import {
  AI_LOGOS,
  buildLogoShape,
  loadLogoMask,
  pairShapes,
  type LogoMask,
  type ShapePoint,
} from './ai-icons';
import type { ChatTurn, SkillCardContent } from '../content/skills';
import type { SkillSceneHandle } from './skill-scene';

export interface AiLabSceneOptions {
  /** 挂载宿主（传 `.skills__frame--swarm`，继承 16:9 尺寸）。 */
  host: HTMLElement;
}

// -- 左栏：对话节奏（毫秒） ---------------------------------------------------

/** 用户在输入框里逐字打入的间隔。 */
const TYPE_MS = 68;
/** 「回车发送」到用户气泡出现之间。 */
const SEND_MS = 240;
/** AI「思考中」要跳多久。 */
const THINK_MS = 900;
/** AI 逐字回复的间隔（比用户打字快）。 */
const REPLY_MS = 26;
/** 一轮结束后的停顿，然后进下一轮。 */
const HOLD_MS = 1200;
/** 气泡流最多留几条，超出就从头部删掉——无限循环下 DOM 必须恒定有界。 */
const MAX_BUBBLES = 8;

// -- 右栏：图标 morph 节奏（毫秒） -------------------------------------------

/** 图标成形后停留多久（用户要「每隔一两秒」，参考站是 5s，这里取个折中）。 */
const DWELL_MS = 2200;
/** 从一个图标变形到下一个的时长。 */
const MORPH_MS = 1200;

// -- 右栏：点阵 ---------------------------------------------------------------

/** 格距 = 画布宽 / DIV_X、高 / DIV_Y，再夹在这个下限之上。数值越小字越密。 */
const DIV_X = 48;
const DIV_Y = 44;
const CELL_MIN = 5.6;
/** 字号占格距的比例。 */
const GLYPH_RATIO = 0.86;
/** 字形贴图用的字体栈（与 ps-bulb / code-typing 的等宽栈保持一致）。 */
const GLYPH_FONT =
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

// -- 右栏：涟漪 ---------------------------------------------------------------
//
// 涟漪只跟指针：指针不在右栏里（pointer.strength → 0）时位移恒为 0，点阵完全静止。
// 强度用缓动逼近 0，所以移出去那一下是「波逐渐平息」而不是硬切。

/** 指针涟漪的振幅。 */
const POINTER_AMP = 6;
/** 指针影响半径的上限，以及相对画布短边的比例。 */
const RIPPLE_RADIUS_MAX = 140;
const RIPPLE_RADIUS_RATIO = 0.32;
/** 指针涟漪的波数（越大圈越密）与角速度。 */
const RIPPLE_K = 0.066;
const RIPPLE_W = 4.2;
/** 指针强度 / 位置的跟随速度（越大越跟手）。 */
const POINTER_EASE = 0.012;

/** 兜底字色（读不到 CSS 变量时用）。 */
const INK_FALLBACK = '#2f6244';

// -- 缓动与工具 ---------------------------------------------------------------

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** 起收都慢的五次缓动——形变看起来才「有机」，而不是被匀速推过去。 */
const smooth = (value: number): number => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** 帧间隔上限：切回标签页时 rAF 会攒出一个巨大的 delta，钳住免得整段动画跳过去。 */
const MAX_DELTA = 64;

/** 码点安全的逐字切分（**不能**用 split('')，那会把代理对切成两半）。 */
const toChars = (text: string): string[] => Array.from(text);

/** 卡片没配 `chat.turns` 时的兜底问答，保证场景单独也能跑。 */
const FALLBACK_TURNS: readonly ChatTurn[] = [
  { user: '帮我写一段产品文案', ai: '已生成 3 版，风格偏科技、生活、极简。' },
  { user: '生成一张赛博朋克海报', ai: '画面已出，青紫霓虹、雨夜街道。' },
  { user: '本地跑一个 7B 模型', ai: '显存够用，量化后约 5GB。' },
];

/** 左栏一轮对话的阶段。 */
type ChatPhase = 'typing' | 'sending' | 'thinking' | 'replying' | 'holding';

/**
 * 一颗字符。
 *
 * 只存 morph 的起点与终点——当前该画在哪、什么透明度、用哪个字形，都在 draw 里
 * 由插值进度现算。成形之后起点 = 终点，于是自然退化成静止。
 */
interface Particle {
  /** 起点：位置 / 不透明度 / 字形。 */
  fx: number;
  fy: number;
  fa: number;
  fg: string;
  /** 终点。 */
  tx: number;
  ty: number;
  ta: number;
  tg: string;
  /** 错峰（0..1 的时间比例）与弧高。 */
  delay: number;
  bend: number;
}

export function createAiLabScene(options: AiLabSceneOptions): SkillSceneHandle {
  const host = options.host;

  // -- DOM ---------------------------------------------------------------------
  //
  // 整块是装饰性动画：默认不吃指针、也不进无障碍树（和 .psbulb 同一条约定）。
  // 例外是右栏——涟漪要跟鼠标，所以 `.ai-lab.is-visible` 时单独把右栏的
  // pointer-events 打开（见 styles.css）。

  const root = document.createElement('div');
  root.className = 'ai-lab';
  root.setAttribute('aria-hidden', 'true');

  const grid = document.createElement('div');
  grid.className = 'ai-lab__grid';

  // 左栏：气泡流 + 底部输入框。
  const chat = document.createElement('div');
  chat.className = 'ai-lab__chat';

  const stream = document.createElement('div');
  stream.className = 'ai-lab__stream';

  const composer = document.createElement('div');
  composer.className = 'ai-lab__composer is-empty';

  const input = document.createElement('span');
  input.className = 'ai-lab__input';
  // 输入框空着时由 CSS 用 attr() 显示这行占位提示。
  input.dataset.placeholder = '输入消息…';
  const inputText = document.createTextNode('');
  input.append(inputText);

  const caret = document.createElement('span');
  caret.className = 'ai-lab__caret';

  const send = document.createElement('span');
  send.className = 'ai-lab__send';
  send.textContent = '↑';

  composer.append(input, caret, send);
  chat.append(stream, composer);

  // 右栏：字符点阵画布。
  const icons = document.createElement('div');
  icons.className = 'ai-lab__icons';

  const canvas = document.createElement('canvas');
  canvas.className = 'ai-lab__icon-canvas';
  icons.append(canvas);

  grid.append(chat, icons);
  root.append(grid);
  host.append(root);

  const ctx = canvas.getContext('2d');

  // -- 状态 --------------------------------------------------------------------

  const reduced = prefersReducedMotion();
  const dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);
  // reduced 下没有涟漪（也就没有指针监听），别让右栏白占一片 hover 热区。
  if (reduced) root.classList.add('is-static');

  let disposed = false;
  let running = false;
  let frame = 0;
  let last = 0;
  let frames = 0;
  /** 只由 dt 累加的动画时钟；形变与指针涟漪都读它，停表即冻结。 */
  let clock = 0;

  // 左栏
  let turns: readonly ChatTurn[] = FALLBACK_TURNS;
  let phase: ChatPhase = 'typing';
  let turn = 0;
  let typed = 0;
  let replied = 0;
  let acc = 0;
  let chatAt = 0;
  let replyNode: Text | null = null;
  let thinkingEl: HTMLElement | null = null;

  // 右栏
  let width = 0;
  let height = 0;
  let cell = CELL_MIN;
  let masks: (LogoMask | null)[] = [];
  let shapes: ShapePoint[][] = [];
  let ready = false;
  let particles: Particle[] = [];
  let iconIndex = 0;
  let pendingIcon = 0;
  let morphing = false;
  let stageAt = 0;

  /** 指针涟漪的状态：位置做指数跟随，强度在进出时平滑升到 1 / 落到 0。 */
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, strength: 0, active: false };

  /** 0 / 1 之外的字符按需预渲染成小画布——逐帧只 drawImage，别 fillText 上千次。 */
  const tileCache = new Map<string, HTMLCanvasElement>();

  /** 字色跟着主题走（只在初始化 / 重建贴图时读一次，不进逐帧路径）。 */
  const readInk = (): string =>
    (typeof window === 'undefined'
      ? ''
      : getComputedStyle(root).getPropertyValue('--ai-ink').trim()) || INK_FALLBACK;

  const tileFor = (glyph: string): HTMLCanvasElement | null => {
    const hit = tileCache.get(glyph);
    if (hit) return hit;
    const px = Math.max(1, Math.round(cell * dpr));
    const sheet = document.createElement('canvas');
    sheet.width = px;
    sheet.height = px;
    const g = sheet.getContext('2d');
    if (!g) return null;
    g.scale(dpr, dpr);
    g.font = `600 ${Math.round(cell * GLYPH_RATIO)}px ${GLYPH_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = readInk();
    g.fillText(glyph, cell / 2, cell * 0.54);
    tileCache.set(glyph, sheet);
    return sheet;
  };

  const rebuildTiles = (): void => {
    tileCache.clear();
    const set = new Set<string>();
    for (const shape of shapes) for (const point of shape) set.add(point.glyph);
    for (const glyph of set) tileFor(glyph);
  };

  // -- 右栏：摆位与形变 --------------------------------------------------------

  /** 把字符一次性摆到某个图形的点阵上（不做补间）——起点终点重合即静止。 */
  const placeShape = (index: number): void => {
    const shape = shapes[index] ?? [];
    particles = shape.map((point) => ({
      fx: point.x,
      fy: point.y,
      fa: point.alpha,
      fg: point.glyph,
      tx: point.x,
      ty: point.y,
      ta: point.alpha,
      tg: point.glyph,
      delay: 0,
      bend: 0,
    }));
    iconIndex = index;
    pendingIcon = index;
    morphing = false;
    root.dataset.aiIcon = String(index);
    root.dataset.aiPoints = String(particles.length);
    if (!running) draw();
  };

  /** 开始一次形变：把当前点阵与目标点阵配对（就近认领 + 错峰 + 弧高）。 */
  const beginMorph = (to: number): void => {
    const from = shapes[iconIndex];
    const target = shapes[to];
    if (!from || !target) return;
    particles = pairShapes(from, target, width, height, cell).map((pair) => ({
      fx: pair.fromX,
      fy: pair.fromY,
      fa: pair.fromA,
      fg: pair.fromGlyph,
      tx: pair.toX,
      ty: pair.toY,
      ta: pair.toA,
      tg: pair.toGlyph,
      delay: pair.delay,
      bend: pair.bend,
    }));
    pendingIcon = to;
    morphing = true;
    root.dataset.aiIconPhase = 'morph';
  };

  // -- 右栏：绘制 --------------------------------------------------------------

  const draw = (): void => {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!ready || particles.length === 0) return;

    const t = morphing ? clamp01((clock - stageAt) / MORPH_MS) : 1;
    const radius = Math.min(
      RIPPLE_RADIUS_MAX,
      Math.min(width, height) * RIPPLE_RADIUS_RATIO,
    );
    const half = cell / 2;
    const ix = pointer.x;
    const iy = pointer.y;
    const strength = pointer.strength;
    const live = strength > 0.002;

    for (const p of particles) {
      const e =
        p.delay >= 1 ? 1 : smooth((t - p.delay) / (1 - p.delay));
      const arc = Math.sin(e * Math.PI) * p.bend;
      const bx = p.fx + (p.tx - p.fx) * e + arc;
      const by = p.fy + (p.ty - p.fy) * e - arc * 0.4;
      const alpha = p.fa + (p.ta - p.fa) * e;
      if (alpha <= 0.015) continue;

      // 涟漪：只有指针在场时才有位移。指针不在（strength→0）→ 位移恒为 0，
      // 点阵安安静静停在目标位上，不会自己抖。
      let shiftX = 0;
      let shiftY = 0;

      if (live) {
        const pdx = bx - ix;
        const pdy = by - iy;
        const pd = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
        const influence = Math.exp(-((pd / radius) * (pd / radius))) * strength;
        const wave = Math.sin(pd * RIPPLE_K - clock * RIPPLE_W) * POINTER_AMP * influence;
        shiftX = (pdx / pd) * wave;
        shiftY = (pdy / pd) * wave;
      }

      const tile = tileFor(e < 0.5 ? p.fg : p.tg);
      if (!tile) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(tile, bx + shiftX - half, by + shiftY - half, cell, cell);
    }
    ctx.globalAlpha = 1;
  };

  // -- 右栏：取形 --------------------------------------------------------------
  //
  // 六个 logo 的蒙版是异步加载的（本地图，几十毫秒），加载完才建点阵。在那之前
  // 画布是空的——比先摆一坨假字符再换掉干净。

  const loadAll = (): void => {
    void Promise.allSettled(AI_LOGOS.map((logo) => loadLogoMask(logo))).then((results) => {
      if (disposed) return;
      masks = results.map((result) => (result.status === 'fulfilled' ? result.value : null));
      const usable = masks.filter((mask): mask is LogoMask => mask !== null).length;
      root.dataset.aiLogos = String(usable);
      if (usable === 0) return;
      ready = true;
      resize(width, height);
      placeShape(iconIndex);
    });
  };

  // -- 右栏：尺寸 --------------------------------------------------------------

  const resize = (w: number, h: number): void => {
    width = Math.max(1, Math.round(w));
    height = Math.max(1, Math.round(h));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cell = Math.max(CELL_MIN, Math.min(width / DIV_X, height / DIV_Y));
    if (ready) {
      shapes = AI_LOGOS.map((logo, i) => {
        const mask = masks[i];
        return mask ? buildLogoShape(mask, logo, width, height, cell) : [];
      });
      rebuildTiles();
      // 尺寸变了就重新落位，不做补间；没在跑（reduced / 已暂停）时补画一帧，
      // 免得画布被清空后一直空着。
      placeShape(iconIndex);
    }
    if (!running) draw();
  };

  // ResizeObserver 的 contentRect 是**分数**、且不受祖先 transform 影响，
  // 比 getBoundingClientRect 稳（`.skills__sticky` 上有 translateY + scale）。
  let observer: ResizeObserver | null = null;
  let onWindowResize: (() => void) | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) resize(rect.width, rect.height);
    });
    observer.observe(icons);
  } else if (typeof window !== 'undefined') {
    onWindowResize = () => resize(icons.clientWidth, icons.clientHeight);
    window.addEventListener('resize', onWindowResize);
  }

  // -- 右栏：指针 → 涟漪 -------------------------------------------------------
  //
  // 坐标走 offsetX / offsetY：`.skills__sticky` 上有 transform，缓存的
  // getBoundingClientRect 会随滚动失效，而 offsetX 由浏览器按当前变换算好，
  // 既不失效、又不用在指针回调里读布局。

  const onPointerMove: ((event: PointerEvent) => void) | null = reduced
    ? null
    : (event) => {
        pointer.targetX = event.offsetX;
        pointer.targetY = event.offsetY;
        if (!pointer.active) {
          pointer.x = pointer.targetX;
          pointer.y = pointer.targetY;
        }
        pointer.active = true;
      };

  const onPointerLeave: (() => void) | null = reduced
    ? null
    : () => {
        pointer.active = false;
      };

  if (onPointerMove && onPointerLeave) {
    icons.addEventListener('pointermove', onPointerMove, { passive: true });
    icons.addEventListener('pointerleave', onPointerLeave);
  }

  // -- 左栏：气泡 --------------------------------------------------------------

  const makeBubble = (kind: 'user' | 'ai'): { el: HTMLElement; text: Text } => {
    const el = document.createElement('div');
    el.className =
      kind === 'user' ? 'ai-lab__bubble ai-lab__bubble--user' : 'ai-lab__bubble ai-lab__bubble--ai';
    const text = document.createTextNode('');
    el.append(text);
    return { el, text };
  };

  const pushBubble = (el: HTMLElement): void => {
    stream.append(el);
    while (stream.children.length > MAX_BUBBLES) {
      const oldest = stream.firstElementChild;
      if (!oldest) break;
      oldest.remove();
    }
    // 每轮只贴一次底（不是逐帧读布局）。
    stream.scrollTop = stream.scrollHeight;
  };

  const beginRound = (index: number): void => {
    turn = index;
    typed = 0;
    replied = 0;
    acc = 0;
    inputText.data = '';
    composer.classList.add('is-empty');
    phase = 'typing';
    root.dataset.aiPhase = phase;
  };

  /** 用户那句话「发出去了」：收进气泡、清空输入框、右侧挂上「思考中」。 */
  const commitUser = (): void => {
    const line = turns[turn];
    const bubble = makeBubble('user');
    bubble.text.data = line ? line.user : '';
    pushBubble(bubble.el);
    inputText.data = '';
    composer.classList.add('is-empty');

    const dots = document.createElement('span');
    dots.className = 'ai-lab__dots';
    for (let i = 0; i < 3; i += 1) dots.append(document.createElement('span'));
    const thinking = document.createElement('div');
    thinking.className = 'ai-lab__bubble ai-lab__bubble--ai ai-lab__bubble--thinking';
    thinking.append(dots);
    thinkingEl = thinking;
    pushBubble(thinking);
  };

  /** 「思考中」结束：把跳动点摘掉，换成一个空的 AI 气泡等着逐字长出来。 */
  const startReply = (): void => {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
    const bubble = makeBubble('ai');
    replyNode = bubble.text;
    pushBubble(bubble.el);
  };

  // -- 主循环 ------------------------------------------------------------------

  const step = (now: number): void => {
    if (!running || disposed) return;
    const delta = last === 0 ? 0 : Math.min(now - last, MAX_DELTA);
    last = now;
    clock += delta;
    acc += delta;

    // 左栏：一轮问答的状态机。
    if (phase === 'typing') {
      const chars = toChars(turns[turn] ? turns[turn].user : '');
      while (acc >= TYPE_MS && typed < chars.length) {
        acc -= TYPE_MS;
        inputText.appendData(chars[typed]);
        typed += 1;
        composer.classList.remove('is-empty');
      }
      if (typed >= chars.length) {
        phase = 'sending';
        chatAt = now;
        acc = 0;
        root.dataset.aiPhase = phase;
      }
    } else if (phase === 'sending') {
      if (now - chatAt >= SEND_MS) {
        commitUser();
        phase = 'thinking';
        chatAt = now;
        root.dataset.aiPhase = phase;
      }
    } else if (phase === 'thinking') {
      if (now - chatAt >= THINK_MS) {
        startReply();
        phase = 'replying';
        acc = 0;
        root.dataset.aiPhase = phase;
      }
    } else if (phase === 'replying') {
      const chars = toChars(turns[turn] ? turns[turn].ai : '');
      const node = replyNode;
      while (acc >= REPLY_MS && replied < chars.length && node) {
        acc -= REPLY_MS;
        node.appendData(chars[replied]);
        replied += 1;
      }
      if (replied >= chars.length) {
        phase = 'holding';
        chatAt = now;
        root.dataset.aiPhase = phase;
      }
    } else if (now - chatAt >= HOLD_MS) {
      // 走到头再回到第一组 —— 十组对话无限循环。
      beginRound((turn + 1) % Math.max(1, turns.length));
    }

    // 右栏：停留 → 形变 → 下一个。
    if (morphing) {
      if (clock - stageAt >= MORPH_MS) {
        placeShape(pendingIcon);
        stageAt = clock;
        root.dataset.aiIconPhase = 'dwell';
      }
    } else if (clock - stageAt >= DWELL_MS) {
      beginMorph((iconIndex + 1) % Math.max(1, AI_LOGOS.length));
      stageAt = clock;
    }

    // 指针涟漪：强度与位置都做指数跟随，离开时平滑回落（不是硬切）。
    const ease = 1 - Math.exp(-delta * POINTER_EASE);
    pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * ease;
    pointer.x += (pointer.targetX - pointer.x) * ease;
    pointer.y += (pointer.targetY - pointer.y) * ease;

    draw();

    frames += 1;
    // 每 16 帧记一次，给验证脚本一个「循环还在不在跑」「涟漪起来没有」的把手
    // （逐帧写 dataset 会把每帧都变成一次 DOM 写，所以跟着这个节拍走）。
    if (frames % 16 === 0) {
      root.dataset.aiFrames = String(frames);
      root.dataset.aiRipple = pointer.strength.toFixed(2);
    }

    frame = window.requestAnimationFrame(step);
  };

  const start = (): void => {
    if (disposed || running) return;
    running = true;
    last = 0;
    frame = window.requestAnimationFrame(step);
  };

  const stop = (): void => {
    running = false;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  // -- 复位 / 静态终态 ---------------------------------------------------------

  const readTurns = (content: SkillCardContent | undefined): readonly ChatTurn[] => {
    const list = content?.chat?.turns;
    return list && list.length > 0 ? list : FALLBACK_TURNS;
  };

  /** 回到起点（但不改 `.is-visible`）：清空气泡、输入框、图标回到第一个。 */
  const reset = (content: SkillCardContent | undefined): void => {
    stop();
    stream.replaceChildren();
    replyNode = null;
    thinkingEl = null;
    turns = readTurns(content);
    beginRound(0);
    clock = 0;
    stageAt = 0;
    pointer.active = false;
    pointer.strength = 0;
    placeShape(0);
    frames = 0;
    root.dataset.aiFrames = '0';
  };

  /** reduced-motion：直接摆出一轮完整问答，右栏停在第一个图标上。 */
  const renderStatic = (): void => {
    const first = turns[0];
    if (first) {
      const userBubble = makeBubble('user');
      userBubble.text.data = first.user;
      pushBubble(userBubble.el);
      const aiBubble = makeBubble('ai');
      aiBubble.text.data = first.ai;
      pushBubble(aiBubble.el);
    }
    inputText.data = '';
    composer.classList.add('is-empty');
    root.dataset.aiPhase = 'static';
    placeShape(0);
  };

  // -- 初始化 ------------------------------------------------------------------

  // 字形贴图先用回退字体兜一版（立刻可见）；字体就绪后重建并补画一帧，
  // 免得字符是用回退字体量出来的、换字体后轻微错位。
  rebuildTiles();
  void whenFontsReady().then(() => {
    if (disposed) return;
    rebuildTiles();
    if (!running) draw();
  });

  // 首帧尺寸兜底；ResizeObserver 的首次回调会立刻带来真实值。
  resize(icons.clientWidth, icons.clientHeight);
  reset(undefined);
  loadAll();

  return {
    element: root,
    show: () => {
      root.style.opacity = '1';
      root.classList.add('is-visible');
    },
    hide: () => {
      root.style.opacity = '0';
      root.classList.remove('is-visible');
      // 藏起来时把涟漪归零，免得下次露出来还带着上一次的指针强度。
      pointer.active = false;
      pointer.strength = 0;
    },
    play: (content: SkillCardContent) => {
      reset(content);
      if (reduced) {
        renderStatic();
        return;
      }
      start();
    },
    cancel: () => {
      stop();
    },
    dispose: () => {
      disposed = true;
      stop();
      if (onPointerMove) icons.removeEventListener('pointermove', onPointerMove);
      if (onPointerLeave) icons.removeEventListener('pointerleave', onPointerLeave);
      observer?.disconnect();
      observer = null;
      if (onWindowResize) window.removeEventListener('resize', onWindowResize);
      root.remove();
    },
  };
}
