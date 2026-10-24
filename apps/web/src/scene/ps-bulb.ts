/**
 * 右栏场景：深色「类 Photoshop」界面里，画出来的鼠标拉出一个虚线选框，框内一颗
 * 手绘线稿灯泡随框从很小放大，指针再点一下把它点亮；之后灯泡可点击切换亮 / 灭。
 *
 * 定位：这是 `SkillSceneHandle` 契约下的一个场景（见 scene/skill-scene.ts），由
 * `sections/skills.ts` 在卡片 1 被选中时挂载进来，替换粒子团。
 *
 * 三条纪律（与 image-compare.ts / swarm-field.ts 一致）：
 *
 *   1. **几何全用百分比**：选框 / 灯泡 / 指针的坐标与尺寸都相对 `.psbulb__canvas`
 *      写成百分比 / 相对单位，存进 CSS 变量。所以帧尺寸变化时浏览器自动重解析，
 *      本模块**不需要任何 `getBoundingClientRect`，也不注册 resize 监听**。
 *   2. **单旋钮 `--lit`**：整盏灯的明暗只由根上的 `--lit ∈ [0,1]` 派生（玻璃填充、
 *      灯丝变亮、火花隐去、外发光全用 `calc()`）。脚本逐帧写它；点击切换用一个小型
 *      rAF 补间——**不用 `@property`、也不让 CSS transition 驱动 `--lit`**，这样
 *      逐帧写入才不会和过渡打架（和 `.skills__card` 的 `transition: none` 同一条纪律）。
 *   3. **reduced-motion 不早退**：和 swarm-field（直接返回空句柄）不同，这里必须
 *      「静态可交互」——照常构建，只把脚本降级成直接落到终态，灯泡随后照常可点。
 */

import { prefersReducedMotion } from './text-support';
import type { SkillCardContent } from '../content/skills';
import type { SkillSceneHandle } from './skill-scene';

export interface PsBulbSceneOptions {
  /** 挂载宿主（传 `.skills__frame--swarm`，继承 16:9 尺寸）。 */
  host: HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// -- 几何（都是画布分数 0..1） -------------------------------------------------

/** 选框左上锚点。 */
const MQ_X = 0.2;
const MQ_Y = 0.24;
/** 拖满时选框的宽 / 高。 */
const MQ_W = 0.6;
const MQ_H = 0.58;
/** 指针入场点。 */
const CURSOR_IN = { x: 0.62, y: 0.08 };
/** 选框左上角（指针第一次落点）。 */
const MQ_CORNER = { x: MQ_X, y: MQ_Y };
/** 选框右下角（拖拽终点）。 */
const MQ_END = { x: MQ_X + MQ_W, y: MQ_Y + MQ_H };
/** 灯泡中心 = 选框中心。 */
const BULB_CENTER = { x: MQ_X + MQ_W / 2, y: MQ_Y + MQ_H / 2 };

// -- 时间线（毫秒，自 play() 起算） -------------------------------------------

const CURSOR_IN_AT = 120;
const CURSOR_IN_MS = 360;
const CLICK1_AT = 500;
/** 单次点击脉冲时长（两次点击共用）。 */
const CLICK_MS = 150;
const DRAG_AT = 660;
const DRAG_MS = 760;
const MOVE_AT = 1620;
const MOVE_MS = 420;
const CLICK2_AT = 2040;
const LIT_AT = 2200;
const LIT_MS = 520;
/** 脚本总时长，到点即落终态。 */
const END_AT = 2900;

/** 点击灯泡时亮 / 灭的过渡时长。 */
const TOGGLE_MS = 480;

// -- 缓动 ---------------------------------------------------------------------

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const span = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from));
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
/** 末端轻微越界再收回——灯泡「噗」地涨满的手感就来自这里。 */
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

// -- 灯泡 SVG 几何（viewBox 0 0 200 350，手绘线稿风格） ------------------------
//
// 参照真实线稿灯泡：白描边的玻璃球体 + 螺口（三条横纹）+ 绿色折线灯丝，周围一圈
// 白色装饰射线。点亮 = 球体填一层半透明绿辉光 + 灯丝换成更亮更粗的绿。

/** 玻璃球体（闭合）。 */
const GLASS_D =
  'M100 14 C58 14 24 48 24 92 C24 128 44 156 72 176 L72 194 ' +
  'L128 194 L128 176 C156 156 176 128 176 92 C176 48 142 14 100 14 Z';
/** 螺口（闭合梯形）。 */
const BASE_D = 'M70 194 L130 194 L124 296 Q100 310 76 296 Z';
/** 螺口三条横纹。 */
const THREADS = ['M73 222 L127 222', 'M74 248 L126 248', 'M76 274 L124 274'];
/** 灯丝：两根引线 + 中间折线。 */
const FILAMENT_D = 'M84 194 L84 152 L92 130 L100 148 L108 130 L116 152 L116 194';
/**
 * 整盏灯在 viewBox（0 0 200 350）里往下挪一点：图形本身只占 y≈0..306，
 * 不挪的话灯泡会偏上、框内下方留白偏多。挪完视觉重心正好落在框中心。
 */
const BULB_SHIFT = 16;
/** 玻璃球体旁的装饰射线（点亮后隐去）。 */
const SPARKS = [
  'M4 68 L20 68',
  'M180 68 L196 68',
  'M100 0 L100 10',
  'M32 20 L44 32',
  'M168 20 L156 32',
  'M12 128 L26 124',
  'M188 128 L174 124',
];

/** 鼠标指针（viewBox 0 0 24 24 的箭头）。 */
const CURSOR_D = 'M4 2 L4 19.5 L9.2 14.7 L12.3 21.6 L15.1 20.3 L12 13.4 L18.6 13.4 Z';

const svgEl = (tag: string, attrs: Record<string, string>): SVGElement => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

export function createPsBulbScene(options: PsBulbSceneOptions): SkillSceneHandle {
  const host = options.host;

  // -- DOM ---------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'psbulb';

  // 顶部菜单条：几枚小色块暗示菜单项，右侧两枚小点暗示窗口按钮。
  const menubar = document.createElement('div');
  menubar.className = 'psbulb__menubar';
  menubar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i += 1) {
    const item = document.createElement('span');
    item.className = 'psbulb__menu';
    menubar.append(item);
  }
  for (let i = 0; i < 2; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'psbulb__menudot';
    menubar.append(dot);
  }

  // 左侧工具条：六枚工具，第二枚是「选中」态。
  const toolbox = document.createElement('div');
  toolbox.className = 'psbulb__toolbox';
  toolbox.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i += 1) {
    const tool = document.createElement('span');
    tool.className = i === 1 ? 'psbulb__tool is-active' : 'psbulb__tool';
    toolbox.append(tool);
  }

  // 画布：选框 / 灯泡 / 指针的公共坐标基准。
  const canvas = document.createElement('div');
  canvas.className = 'psbulb__canvas';

  const marquee = document.createElement('div');
  marquee.className = 'psbulb__marquee';
  marquee.setAttribute('aria-hidden', 'true');

  // 灯泡既是画面主体，也是脚本结束后唯一的交互控件。
  const bulb = document.createElement('button');
  bulb.type = 'button';
  bulb.className = 'psbulb__bulb';
  bulb.setAttribute('aria-pressed', 'false');
  bulb.setAttribute('aria-label', '点亮灯泡');

  const bulbSvg = svgEl('svg', {
    class: 'psbulb__bulb-svg',
    viewBox: '0 0 200 350',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  // 所有零件放进一个整体下移的 <g>，让灯泡在框里居中（见 BULB_SHIFT）。
  const bulbGroup = svgEl('g', { transform: `translate(0 ${BULB_SHIFT})` });
  const addPath = (d: string, cls: string): void => {
    bulbGroup.append(svgEl('path', { class: cls, d }));
  };
  // 先填充层（同一路径），再叠白描边——点亮时球体内部透出绿辉光。
  addPath(GLASS_D, 'psbulb__glass-fill');
  addPath(GLASS_D, 'psbulb__outline');
  addPath(BASE_D, 'psbulb__outline');
  THREADS.forEach((d) => addPath(d, 'psbulb__thread'));
  addPath(FILAMENT_D, 'psbulb__filament');
  addPath(FILAMENT_D, 'psbulb__filament-glow');
  SPARKS.forEach((d) => addPath(d, 'psbulb__spark'));
  bulbSvg.append(bulbGroup);
  bulb.append(bulbSvg);

  const cursor = svgEl('svg', {
    class: 'psbulb__cursor',
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  cursor.append(svgEl('path', { class: 'psbulb__cursor-arrow', d: CURSOR_D }));

  canvas.append(marquee, bulb, cursor);
  root.append(menubar, toolbox, canvas);
  host.append(root);

  // -- 状态 --------------------------------------------------------------------

  const reduced = prefersReducedMotion();
  let settled = false;
  let lit = false;
  /** 当前「点亮程度」，脚本与点击补间共用同一个写点。 */
  let litValue = 0;
  let scriptFrame = 0;
  let scriptStart = 0;
  let litFrame = 0;
  let disposed = false;

  /** 唯一的 `--lit` 写点。 */
  const writeLit = (value: number): void => {
    litValue = clamp01(value);
    root.style.setProperty('--lit', litValue.toFixed(4));
  };

  const setVar = (name: string, value: string): void => {
    root.style.setProperty(name, value);
  };

  const setPressed = (on: boolean): void => {
    bulb.setAttribute('aria-pressed', on ? 'true' : 'false');
    bulb.setAttribute('aria-label', on ? '熄灭灯泡' : '点亮灯泡');
  };

  // -- 脚本时间线 --------------------------------------------------------------

  /** 指针位置：入场 → 选框左上 → 沿对角线拖到右下 → 移到灯泡中心。 */
  const cursorAt = (elapsed: number): { x: number; y: number } => {
    let point = mix(CURSOR_IN, MQ_CORNER, easeOutCubic(span(elapsed, CURSOR_IN_AT, CURSOR_IN_AT + CURSOR_IN_MS)));
    if (elapsed >= DRAG_AT) {
      point = mix(MQ_CORNER, MQ_END, easeOutCubic(span(elapsed, DRAG_AT, DRAG_AT + DRAG_MS)));
    }
    if (elapsed >= MOVE_AT) {
      point = mix(MQ_END, BULB_CENTER, easeOutCubic(span(elapsed, MOVE_AT, MOVE_AT + MOVE_MS)));
    }
    return point;
  };

  /** 单次点击的 0→1→0 脉冲。 */
  const pulse = (elapsed: number, at: number): number =>
    Math.sin(Math.PI * span(elapsed, at, at + CLICK_MS));

  /** 把时间线在 `elapsed` 处的状态写进 CSS 变量（不做任何布局读）。 */
  const renderScript = (elapsed: number): void => {
    // 选框：按缓出从左上角向右下角长出来。
    const box = easeOutCubic(span(elapsed, DRAG_AT, DRAG_AT + DRAG_MS));
    setVar('--mq-w', `${(MQ_W * 100 * box).toFixed(3)}%`);
    setVar('--mq-h', `${(MQ_H * 100 * box).toFixed(3)}%`);

    // 灯泡：随选框一起从 0 涨到 1（末端轻微过冲）。
    setVar('--bulb-scale', easeOutBack(span(elapsed, DRAG_AT, DRAG_AT + DRAG_MS)).toFixed(4));

    // 指针：位置 + 点击时的脉冲缩放。
    const point = cursorAt(elapsed);
    setVar('--cx', `${(point.x * 100).toFixed(3)}%`);
    setVar('--cy', `${(point.y * 100).toFixed(3)}%`);
    const click = Math.max(pulse(elapsed, CLICK1_AT), pulse(elapsed, CLICK2_AT));
    setVar('--click', (1 - 0.14 * click).toFixed(4));

    // 点亮：第二次点击之后。
    writeLit(easeOutCubic(span(elapsed, LIT_AT, LIT_AT + LIT_MS)));
  };

  const cancelScript = (): void => {
    if (scriptFrame) {
      window.cancelAnimationFrame(scriptFrame);
      scriptFrame = 0;
    }
  };

  const cancelLit = (): void => {
    if (litFrame) {
      window.cancelAnimationFrame(litFrame);
      litFrame = 0;
    }
  };

  const finish = (): void => {
    scriptFrame = 0;
    settled = true;
    lit = true;
    writeLit(1);
    setPressed(true);
    cursor.style.display = 'none';
    root.classList.add('is-settled');
  };

  const step = (now: number): void => {
    if (disposed) return;
    const elapsed = now - scriptStart;
    if (elapsed >= END_AT) {
      renderScript(END_AT);
      finish();
      return;
    }
    renderScript(elapsed);
    scriptFrame = window.requestAnimationFrame(step);
  };

  /** 静态呈现（reduced-motion）：直接落到脚本终态，灯泡随后照常可点。 */
  const applyFinalState = (): void => {
    setVar('--mq-w', `${(MQ_W * 100).toFixed(3)}%`);
    setVar('--mq-h', `${(MQ_H * 100).toFixed(3)}%`);
    setVar('--bulb-scale', '1');
    cursor.style.display = 'none';
    finish();
  };

  /** 回到脚本起点（但不改 `.is-visible`）。 */
  const reset = (): void => {
    cancelScript();
    cancelLit();
    settled = false;
    lit = false;
    root.classList.remove('is-settled');
    cursor.style.display = '';
    setVar('--mq-x', `${(MQ_X * 100).toFixed(3)}%`);
    setVar('--mq-y', `${(MQ_Y * 100).toFixed(3)}%`);
    setVar('--mq-w', '0%');
    setVar('--mq-h', '0%');
    setVar('--bulb-scale', '0');
    setVar('--cx', `${(CURSOR_IN.x * 100).toFixed(3)}%`);
    setVar('--cy', `${(CURSOR_IN.y * 100).toFixed(3)}%`);
    setVar('--click', '1');
    writeLit(0);
    setPressed(false);
  };

  // -- 点击灯泡：亮 / 灭 -------------------------------------------------------

  const tweenLit = (target: number): void => {
    cancelLit();
    const from = litValue;
    const start = performance.now();
    const run = (now: number): void => {
      if (disposed) return;
      const u = clamp01((now - start) / TOGGLE_MS);
      writeLit(lerp(from, target, easeOutCubic(u)));
      if (u >= 1) {
        litFrame = 0;
        return;
      }
      litFrame = window.requestAnimationFrame(run);
    };
    litFrame = window.requestAnimationFrame(run);
  };

  const setLit = (on: boolean): void => {
    lit = on;
    setPressed(on);
    cancelLit();
    if (reduced) writeLit(on ? 1 : 0);
    else tweenLit(on ? 1 : 0);
  };

  const onBulbClick = (): void => {
    // 脚本播放中按钮是 pointer-events: none，这里再兜一层，避免和脚本抢 --lit。
    if (!settled) return;
    setLit(!lit);
  };
  bulb.addEventListener('click', onBulbClick);

  // 初始状态：选框归零、灯泡 scale 0、指针待命。
  reset();

  return {
    element: root,
    show: () => {
      root.style.opacity = '1';
      root.classList.add('is-visible');
    },
    hide: () => {
      root.style.opacity = '0';
      root.classList.remove('is-visible');
    },
    play: (_content: SkillCardContent) => {
      reset();
      if (reduced) {
        applyFinalState();
        return;
      }
      scriptStart = performance.now();
      scriptFrame = window.requestAnimationFrame(step);
    },
    cancel: () => {
      cancelScript();
      cancelLit();
    },
    dispose: () => {
      disposed = true;
      cancelScript();
      cancelLit();
      bulb.removeEventListener('click', onBulbClick);
      root.remove();
    },
  };
}
