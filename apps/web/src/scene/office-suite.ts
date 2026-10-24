/**
 * 右栏「Office 办公」场景：用纯 DOM / CSS 画出 Word、Excel、PowerPoint 三个软件的
 * 界面（功能区 + 文档页 / 表格 + 图表 / 幻灯片），依次淡入淡出、周而复始。
 *
 * 定位：`SkillSceneHandle` 契约下的一个场景（见 scene/skill-scene.ts），由
 * `sections/skills.ts` 的注册表按 id（`office-suite`）惰性创建。这里只关心
 * 「怎么把三个界面画出来、怎么轮播」，不管卡片命中与显隐时序。
 *
 * 三条纪律（与 ps-bulb.ts / code-typing.ts 一致）：
 *
 *   1. **逐帧写入不挂过渡**：三视图的不透明度由根本变量 `--o-word / --o-excel /
 *      --o-ppt` 用 `calc()` 派生，脚本每帧只写这三个变量；视图自身**不声明
 *      transition**。只有根 `.office-suite` 的 opacity（离散的 show / hide）在
 *      `.is-settled` 之后才由 CSS 打开过渡（那条规则写在本场景自己的样式块里）。
 *   2. **几何全用百分比 / 相对单位**：所有子元素尺寸相对 16:9 的框写成 %，帧尺寸
 *      变化时浏览器自动重解析——本模块**不注册 resize、不读 getBoundingClientRect**。
 *   3. **reduced-motion 不早退**：照常把三个界面都建出来，只把循环降级成「静态停在
 *      Word 视图」，而不是整段返回空句柄。
 *
 * 依赖方向：content/skills.ts（无依赖）← 本文件 ← sections/skills.ts。
 */

import { prefersReducedMotion } from './text-support';
import type { SkillCardContent } from '../content/skills';
import type { SkillSceneHandle } from './skill-scene';

export interface OfficeSuiteSceneOptions {
  /** 挂载宿主（传 `.skills__frame--swarm`，继承 16:9 尺寸与 `--frame-radius`）。 */
  host: HTMLElement;
}

// -- 节奏（毫秒，自 play() 起算） ---------------------------------------------

/** 淡入 + 轻微上滑。 */
const ENTER_MS = 560;
/** 每个界面停留时长。 */
const HOLD_MS = 2400;
/** 淡出时长。 */
const FADE_MS = 520;
/** 相邻两个界面开始播放的间隔 = 淡入 + 停留（所以上一个开始淡出时下一个正好开始淡入）。 */
const SLOT_MS = ENTER_MS + HOLD_MS;
/** 一轮（三个界面）的总时长。 */
const CYCLE_MS = SLOT_MS * 3;

/** 视图数量。 */
const VIEW_COUNT = 3;

// -- 缓动 ---------------------------------------------------------------------

const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * 第 index 个视图在整体时刻 `t` 的不透明度。纯时间函数，跨 CYCLE 天然循环、无漂移：
 *
 *   local < ENTER               → easeOut 淡入
 *   local < ENTER + HOLD        → 1（平台）
 *   local < ENTER + HOLD + FADE → 1 - easeOut 淡出
 *   否则                        → 0
 *
 * `+ ENTER_MS` 这个相位是必须的：视图的淡出窗口会跨过周期边界（第 3 个视图的淡出落在
 * `[3·SLOT, 3·SLOT+FADE]`，模掉周期后正好是 `[0, FADE]`）。不加相位的话，`t = 0` 会
 * 落在「第 3 个视图正满、第 1 个视图刚起」的交叉点上——`play()` 一开场就闪出 PPT。
 * 相位挪到第 1 个视图的停留平台内，`t = 0` 即 Word 满屏，其余归零。
 */
const alphaAt = (t: number, index: number): number => {
  const local = (((t + ENTER_MS - index * SLOT_MS) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  if (local < ENTER_MS) return easeOut(local / ENTER_MS);
  if (local < ENTER_MS + HOLD_MS) return 1;
  if (local < ENTER_MS + HOLD_MS + FADE_MS) {
    return 1 - easeOut((local - ENTER_MS - HOLD_MS) / FADE_MS);
  }
  return 0;
};

// -- DOM 工具 -----------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** 功能区：7 个半透明按钮块，颜色由所属视图的 ribbon 背景决定。 */
const buildRibbon = (): HTMLElement => {
  const ribbon = el('div', 'office-suite__ribbon');
  for (let i = 0; i < 7; i += 1) ribbon.append(el('span', 'office-suite__ribbon-btn'));
  return ribbon;
};

/** Word：白纸文档页——标题 + 分隔线 + 段落线 + 项目符号列表。 */
const buildWordView = (): HTMLElement => {
  const view = el('div', 'office-suite__view office-suite__view--word');
  const page = el('div', 'office-suite__page');

  page.append(el('div', 'office-suite__doc-title', '项目总结报告'));
  page.append(el('div', 'office-suite__rule'));

  for (const width of [96, 92, 88, 94, 70]) {
    const line = el('div', 'office-suite__line');
    line.style.width = `${width}%`;
    page.append(line);
  }

  for (const width of [64, 58, 46]) {
    const item = el('div', 'office-suite__bullet');
    const bar = el('span', 'office-suite__bullet-bar');
    bar.style.width = `${width}%`;
    item.append(el('span', 'office-suite__bullet-dot'), bar);
    page.append(item);
  }

  view.append(buildRibbon(), page);
  return view;
};

/** Excel：绿色功能区 + 网格表 + 条形图。 */
const buildExcelView = (): HTMLElement => {
  const view = el('div', 'office-suite__view office-suite__view--excel');
  const sheet = el('div', 'office-suite__sheet');

  const grid = el('div', 'office-suite__grid');
  const rows: readonly (readonly string[])[] = [
    ['', '项目', '数值', '占比'],
    ['1', '产品A', '1280', '32%'],
    ['2', '产品B', '960', '24%'],
    ['3', '产品C', '1420', '35%'],
    ['4', '产品D', '360', '9%'],
    ['5', '合计', '4020', '100%'],
  ];
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const head = r === 0 || c === 0;
      grid.append(
        el('div', head ? 'office-suite__cell office-suite__cell--head' : 'office-suite__cell', value),
      );
    });
  });

  const chart = el('div', 'office-suite__chart');
  for (const height of [42, 68, 55, 84, 62, 92]) {
    const bar = el('div', 'office-suite__bar');
    bar.style.height = `${height}%`;
    chart.append(bar);
  }

  sheet.append(grid, chart);
  view.append(buildRibbon(), sheet);
  return view;
};

/** PowerPoint：橙色功能区 + 幻灯片（标题 + 项目符号 + 图形）。 */
const buildPptView = (): HTMLElement => {
  const view = el('div', 'office-suite__view office-suite__view--ppt');
  const slide = el('div', 'office-suite__slide');

  slide.append(el('div', 'office-suite__slide-title', '年度设计汇报'));

  const body = el('div', 'office-suite__slide-body');
  for (const width of [72, 64, 58]) {
    const item = el('div', 'office-suite__slide-item');
    const bar = el('span', 'office-suite__slide-bar');
    bar.style.width = `${width}%`;
    item.append(el('span', 'office-suite__slide-dot'), bar);
    body.append(item);
  }
  slide.append(body, el('div', 'office-suite__slide-shape'));

  view.append(buildRibbon(), slide);
  return view;
};

// -- 常量表 -------------------------------------------------------------------

/** 三视图各自的不透明度变量名（写在根上，由 CSS 派生出 opacity / transform）。 */
const VIEW_VARS = ['--o-word', '--o-excel', '--o-ppt'] as const;
/** 顶栏应用徽标文案。 */
const APP_LABELS = ['Word', 'Excel', 'PowerPoint'] as const;
/** 顶栏文件名。 */
const FILE_NAMES = ['项目总结报告.docx', '销售数据.xlsx', '年度设计汇报.pptx'] as const;

export function createOfficeSuite(options: OfficeSuiteSceneOptions): SkillSceneHandle {
  const root = el('div', 'office-suite');
  root.setAttribute('aria-hidden', 'true');

  // 顶栏：三颗交通灯 + 应用徽标 + 文件名（靠右）。
  const chrome = el('div', 'office-suite__chrome');
  const lights = el('div', 'office-suite__lights');
  for (let i = 0; i < 3; i += 1) lights.append(el('span', 'office-suite__light'));
  const badge = el('span', 'office-suite__badge', APP_LABELS[0]);
  const file = el('span', 'office-suite__file', FILE_NAMES[0]);
  chrome.append(lights, badge, file);

  // 舞台：三个界面叠放，各自的 opacity / transform 由根上的 --o-* 派生。
  const stage = el('div', 'office-suite__stage');
  stage.append(buildWordView(), buildExcelView(), buildPptView());

  // 底部指示点：离散更新，可安全挂过渡。
  const dots = el('div', 'office-suite__dots');
  const dotEls: HTMLElement[] = [];
  for (let i = 0; i < VIEW_COUNT; i += 1) {
    const dot = el('span', 'office-suite__dot');
    dotEls.push(dot);
    dots.append(dot);
  }

  root.append(chrome, stage, dots);
  options.host.append(root);

  let frame = 0;
  let startAt = 0;
  let running = false;
  let disposed = false;
  let activeIndex = -1;

  /** 离散切到某个界面：更新徽标 / 文件名 / 指示点（不是逐帧写，所以可以有过渡）。 */
  const setActive = (index: number): void => {
    if (index === activeIndex) return;
    activeIndex = index;
    badge.textContent = APP_LABELS[index];
    file.textContent = FILE_NAMES[index];
    dotEls.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
  };

  /** 唯一的写点：把三视图的不透明度写进根上的 CSS 变量（不读布局、不挂过渡）。 */
  const writeFrame = (t: number): void => {
    let best = 0;
    let bestAlpha = -1;
    for (let i = 0; i < VIEW_COUNT; i += 1) {
      const alpha = alphaAt(t, i);
      root.style.setProperty(VIEW_VARS[i], alpha.toFixed(4));
      if (alpha > bestAlpha) {
        bestAlpha = alpha;
        best = i;
      }
    }
    setActive(best);
  };

  const stop = (): void => {
    running = false;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const step = (now: number): void => {
    if (!running || disposed) return;
    writeFrame(now - startAt);
    frame = window.requestAnimationFrame(step);
  };

  const start = (): void => {
    if (disposed || running) return;
    running = true;
    startAt = performance.now();
    frame = window.requestAnimationFrame(step);
  };

  /** 静态呈现（reduced-motion）：停在 Word 视图，不跑循环。 */
  const renderStatic = (): void => {
    stop();
    root.style.setProperty('--o-word', '1');
    root.style.setProperty('--o-excel', '0');
    root.style.setProperty('--o-ppt', '0');
    setActive(0);
  };

  // 初始态：t=0 即 Word 满屏、另两个归零（相位见 alphaAt）。整块入场由根元素的
  // opacity 过渡负责（`.is-settled` 之后），这里不必再做淡入。
  writeFrame(0);

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
      writeFrame(0);
      if (prefersReducedMotion()) {
        renderStatic();
        return;
      }
      start();
    },
    cancel: stop,
    dispose: () => {
      disposed = true;
      stop();
      root.remove();
    },
  };
}
