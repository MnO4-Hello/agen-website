/**
 * 结尾区块 `.s-my-way`——参考站的移植。
 *
 * 这一块和 WORK 段完全是两套机制：它**不是滚动驱动的时间轴**，而是一个自跑的
 * 物理小世界：
 *
 *   - 一组 3D「相框 / 星星」对象，用 `transform-style: preserve-3d` 加伪元素补出
 *     厚度面，做成真的小盒子；
 *   - 对象从 `z = -2e4` 的近景深处朝镜头飞（`z += vz`，`--s` 同步长大），飞过头顶
 *     （`z > 1000`）就回收进对象池——**只回收元素，不删除**，34 屏的滚动里不建删 DOM；
 *   - 指针按下即进入拖拽：每帧用弹簧把对象拽向指针（`v += (target − x) * 0.075`，
     再 `v *= 0.9`），速度直接映射成倾角，所以甩动时卡片会跟着歪；
 *   - **松手即消散**（参考站没有速度阈值）：加 `is-vanishing`，用 mask 精灵横扫
 *     配合重力下落，1 秒后回收；
 *   - 段落进入视口后自动每隔 0.5~1.5 秒随机甩一个出来，同屏最多 5 个；
 *   - 底部四行大字做了两份：一份带 `matrix3d` 竖向斜切（碗状透视），一份不带，
 *     靠 `--scroll-progress` 平滑推进，制造「从碗底升上来」的错位；
 *   - 鼠标位置本身也是插值跟随的（`sx += (x − sx) * 0.1`），所以拖拽带一点黏滞。
 *
 * 素材：消散遮罩 `sprite-vanish.png`（30 帧精灵横扫）与星形贴图 `asset-star.svg` 已从
 * 参考站取到、放进 `public/images/`，样式里按原站写法（mask + `steps(29, end)`）接上。
 *
 * 以下三处是**照参考站实现**的、最容易写错的地方，改动前先读这段：
 *   - `drawLines()`：从**上下左右四条边**发射、汇聚到笑脸中心的 1px 长线（列数 12/8，
 *     行数同列数），外加底边一条横线——不是「围着中心画一圈小刻度」。
 *   - `perspectiveOrigin`：取 `.s__ruler` 的**实测高度**。该值属于**对象层坐标**，
 *     而对象层上下各外扩 100vh，所以不能拿板块自身高度去算。
 *   - 笑脸：一个 primary 圆底（`<circle>`）+ 一个 secondary 的 `<path>`
 *     （外环轮廓 + 两眼 + 嘴弧），path 逐字取自参考站。
 */

import { gsap } from './gsap-support';
import { MY_WAY_FRAMES, MY_WAY_LINES, MY_WAY_STAR_COUNT, type MyWayFrame } from '../content/my-way';

/** 同屏最多几个被甩出的对象。参考站 5。 */
const MAX_THROWN = 5;

/** 回收延迟（ms）——与 CSS 里 `animation: vanish .75s` + `delay .105s` 对齐，留一点余量。 */
const VANISH_DELAY = 1000;

/** CSS 里消散精灵动画的时长（秒）——`?mwvanish=` 要按它换算暂停时的负偏移。 */
const VANISH_ANIM_DURATION = 0.75;

/** 滚动进度的插值系数（参考站 `sp += (p − sp) * 0.1`）。 */
const SCROLL_LERP = 0.1;

/** 鼠标位置的插值系数。 */
const MOUSE_LERP = 0.1;

/**
 * 笑脸的 path，**逐字**取自参考站 `.s__smiley`（758 字符，5 个子路径）：
 * 外环轮廓（正反两条闭合曲线挖出细环）+ 两只眼睛 + 一道嘴弧，全部 secondary 色。
 * 拆成 5 段只是为了不出现 800 字符的长行——**拼接顺序与内容不能改**，
 * 尤其第 4 段必须以小写 `m` 起头（相对 moveto，接在上一个子路径的闭合点上）。
 */
const SMILEY_PATH =
  'M38.9 77.8c-2 0-4.1-.2-6.2-.5C11.6 73.9-2.9 53.9.5 32.8 2.1 22.5 7.7 13.5 16.1 7.4c8.4-6.1 18.7-8.5 29-6.9 10.3 1.6 19.3 7.2 25.4 15.6 6.1 8.4 8.5 18.7 6.9 29-3.1 19.1-19.7 32.7-38.5 32.7z' +
  'M38.8 1c-7.9 0-15.6 2.5-22.1 7.2C8.5 14.1 3.1 22.9 1.5 32.9-1.8 53.5 12.3 73 32.9 76.3 53.5 79.6 73 65.5 76.3 44.9l.5.1-.5-.1c1.6-10-.8-20-6.7-28.2S54.9 3.1 44.9 1.5c-2-.3-4.1-.5-6.1-.5z' +
  'M25.5 23.1c-1.9 0-3.5 2-4.1 5.1l-.1.3 3 2.2-2.9 2.2.1.3c.6 2.5 1.5 5.1 4.1 5.1 2.4 0 4.2-3.3 4.2-7.6s-2.4-7.6-4.3-7.6z' +
  'm26.6 0c-1.9 0-3.5 2-4.1 5.1v.3l3 2.2-3 2.2.1.3c.6 2.5 1.5 5.1 4.1 5.1 2.4 0 4.2-3.3 4.2-7.6s-2.3-7.6-4.3-7.6z' +
  'M62 39c0-.3-.2-.5-.5-.5s-.5.2-.5.5c0 12.2-9.9 22.1-22.1 22.1-12.2 0-22.1-9.9-22.1-22.1 0-.3-.2-.5-.5-.5s-.5.2-.5.5c0 12.7 10.4 23.1 23.1 23.1S62 51.7 62 39z';

/** 参考站 `setLines()` 的列数：视口宽 > 767 用 12 列（8 列是它的窄屏档）。行数取同一个值。 */
const LINES_COLS_DESKTOP = 12;
const LINES_COLS_COMPACT = 8;

/** 参考站 `setSize()` 从 `.s__ruler` 的实测高度推透视原点，这里留一个兜底比例。 */
const RULER_FALLBACK_RATIO = 0.4;

/* —— 截图 / 诊断用的 URL 状态钩子（仅 DEV；生产构建整段被 DCE 掉） ——
   这台机器上 Edge 的两条 DevTools 通道都不可用（详见 `sections/works.ts` 顶部的长注释），
   只剩 `--headless --screenshot`，而它没法在加载之后注入滚动或拨时间。所以把「落到哪一帧
   状态」编码进 URL，让页面自己在初始化末尾落过去：

     ?mw=0.5        强制 `--scroll-progress` 并冻结（本段的滚动驱动只有这一个变量）
     ?mwobjects=4   把 4 个对象摆到确定位置并冻结物理（否则截到的是随机相位）
     ?mwbg=0        覆盖背景对象的数量（0 = 一个都不摆，得到完全确定的舞台）
     ?mwvanish=0.5  把第一个对象钉在消散动画的 50% 上（暂停 + seek，可重复截同一帧）
     ?mwshot=1      把前面的板块和 WORK 段藏掉，让本段顶到文档最上面
     ?sink=9099     发送读数到本机 beacon 汇（与 works 段共用这个参数名）

   为什么需要 `?mwshot=1`：`--screenshot` 抓的是**文档第 0 行到 windowHeight 行**，不管
   当前滚动位置。本段在页面末尾（前面隔着 1700lvh 的 WORK 段），不藏掉前面就永远截不到。
   注意它只影响 DEV 截图，和 `works.ts` 的 `?paint=1` 一样属于调试脚手架。 */
const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;

const readDevNumber = (key: string): number | null => {
  const raw = devParams?.get(key) ?? null;
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

const devScrollProgress = readDevNumber('mw');
const devObjectCount = readDevNumber('mwobjects');
/** `?mwbg=<n>`：覆盖「段落刚出现时摆几个背景对象」的数量（0 = 一个都不摆）。
 *  背景对象的位置是随机的，会把逐像素 A/B 搅浑；给 0 就得到一个**完全确定**的舞台，
 *  改动的效果能被逐像素量出来（比如星形厚度面的旋向）。 */
const devBackgroundCount = readDevNumber('mwbg');
/** `?mwvanish=<0..1>`：把第一个对象钉在消散动画的该进度上（且不回收），用来验精灵遮罩真的生效。
 *  给**进度**而不是给开关，是为了能做「帧 0 vs 帧 0.5」的逐像素 A/B——只截一帧的话，
 *  万一 `sprite-vanish.png` 是张全黑或全白的图，看单帧是分辨不出来的。 */
const devVanish = readDevNumber('mwvanish');

/** `?mwshot=1`：只留 `.s-my-way` 一屏，并把滚动锁与所有动画按掉。 */
const installShotStyles = (): void => {
  const style = document.createElement('style');
  style.id = '__my-way-shot-mode';
  style.textContent = [
    // 前面两屏的滚动锁会把页面按在第一屏（headless 里没有真实滚动），先解除。
    'body.is-identity-locked,body.is-skills-locked{position:static !important;' +
      'overflow:visible !important;top:auto !important;left:auto !important;' +
      'right:auto !important;width:auto !important;}',
    // 只留本段：`--screenshot` 只能拍文档开头那一屏。
    'html.is-my-way-shot .app-shell > *{display:none !important;}',
    'html.is-my-way-shot .app-shell > .works{display:block !important;}',
    'html.is-my-way-shot .works > *{display:none !important;}',
    'html.is-my-way-shot .works > .s-my-way{display:flex !important;}',
    // 动画只按掉笑脸的自转（截到哪个角度不确定），**其余动画要留着**——
    // 消散精灵（`steps(29, end)` 那条）就是靠 `?mwvanish=` 截出来验的。
    'html.is-my-way-shot *,html.is-my-way-shot *::before,html.is-my-way-shot *::after{' +
      'transition:none !important;will-change:auto !important;}',
    'html.is-my-way-shot .s__smiley{animation:none !important;}',
  ].join('\n');
  document.head.append(style);
  document.documentElement.classList.add('is-my-way-shot');
};

if (devParams?.get('mwshot') === '1') installShotStyles();

/** 段落可见范围判定：section 顶部进入视口 → 底部离开视口的归一化进度。 */
export interface MyWayHandle {
  readonly element: HTMLElement;
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一个可拖拽 / 可甩出的 3D 对象。 */
class WayObject {
  readonly el: HTMLElement;

  private readonly scene: MyWayScene;
  private readonly parity: number;

  /** 物理被冻结但**仍然可见**（参考站的 `isWaiting`）。 */
  private frozen = true;
  /** 被 `.is-waiting` 隐藏、已归还对象池。 */
  private pooled = true;
  private dragging = false;
  private vanishing = false;
  /**
   * DEV 冻帧：被 `place()` / `holdVanish()` 钉在确定状态上的对象。
   * `revive()` 遇到它必须直接返回——那些对象是被**故意**冻住的，解冻会让截图失去确定性。
   */
  private pinned = false;

  private scale = 1;
  private pos: Vec3 = { x: 0, y: 0, z: -20000 };
  private rot: Vec3 = { x: 90, y: 0, z: 0 };
  private vel: Vec3 = { x: 0, y: 0, z: 45 };
  private spin = { x: 0.5, y: 0.5 };
  private vanishStart = 0;

  constructor(el: HTMLElement, scene: MyWayScene, parity: number) {
    this.el = el;
    this.scene = scene;
    this.parity = parity;
  }

  /**
   * 重置对象。
   *
   * @param scatter `true` = 冲出屏幕（用于甩出）；`false` = 直接散落在场景里当背景
   *                （段落刚出现时的那 2~5 个）。
   */
  reset(scatter: boolean): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.el.classList.remove('is-waiting', 'is-dragging', 'is-vanishing');
    this.pooled = false;
    this.dragging = false;
    this.vanishing = false;
    this.vanishStart = 0;
    // 回到正常物理路径，DEV 的钉帧标记一并撤销。
    this.pinned = false;

    this.pos = { x: 0, y: 0, z: -20000 };
    this.rot = { x: 90, y: Math.random() * 2 - 1, z: 0 };
    this.vel = {
      x: Math.random() * width * 0.0025 * (this.parity % 2 ? -1 : 1),
      y: Math.random() * height * 0.0025 * (this.parity % 3 ? -1 : 1),
      z: 40 + Math.random() * 10,
    };
    this.spin = { x: 0.25 + Math.random(), y: 0.25 + Math.random() };
    this.scale = 0;
    this.el.style.setProperty('--size', String(0.5 + Math.random() * 0.5));

    if (scatter) {
      this.frozen = false;
    } else {
      // 背景态：冻住物理，但摆在场景里（不是 display:none）。
      this.frozen = true;
      this.scale = 1;
      this.pos = {
        x: this.vel.x * Math.random() * 200,
        y: this.vel.y * Math.random() * 200,
        z: Math.random() * -20000,
      };
      this.rot = { x: Math.random() * 360, y: Math.random() * 360, z: 0 };
    }

    // 立刻落一次样式：背景态是 `frozen`（不跑 `update`），不写就会被 CSS 默认值
    // `--s: 0` 缩成看不见。
    this.write();
  }

  /** 把当前状态写进 CSS 变量。 */
  private write(): void {
    const { style } = this.el;
    style.setProperty('--x', `${this.pos.x.toFixed(2)}px`);
    style.setProperty('--y', `${this.pos.y.toFixed(2)}px`);
    style.setProperty('--z', `${this.pos.z.toFixed(2)}px`);
    style.setProperty('--rx', this.rot.x.toFixed(3));
    style.setProperty('--ry', this.rot.y.toFixed(3));
    style.setProperty('--rz', this.rot.z.toFixed(3));
    style.setProperty('--s', this.scale.toFixed(4));
  }

  /** 归还对象池并隐藏。 */
  recycle(): void {
    if (this.pooled) return;
    this.pooled = true;
    this.frozen = true;
    this.dragging = false;
    this.vanishing = false;
    this.el.classList.add('is-waiting');
    this.scene.onObjectRecycled(this);
  }

  /**
   * 段落进入视口：解冻，并把被隐藏的对象放回场景。
   *
   * **必须把 `frozen` 一起清掉，不能只清 `is-waiting`。**
   * 参考站只有一个 `isWaiting` 标志同时管「隐藏」和「冻结」，它的
   * `onIntersect(){ … thrownObjects.forEach(e => e.isWaiting = false) }` 会在段落进视口时
   * 把这一个标志清掉——效果就是「段落刚出现时摆进场景当背景的那几个对象」随即飞起来。
   * 本项目把该标志拆成了 `frozen`（可见 / 冻结）与 `pooled`（隐藏 / 入池）两个字段，
   * 而这里原来开头是 `if (!this.pooled) return;`，于是只还原了 `pooled`、**漏了 `frozen`**：
   * 背景对象永远停在 `reset(false)` 那一刻（`update()` 被开头的 `if (this.frozen) return;` 挡住，
   * 连拖拽也救不了），正是用户看到的「星星一直卡在界面里不动」。
   */
  revive(): void {
    if (this.pinned) return;
    this.frozen = false;
    if (!this.pooled) return;
    this.pooled = false;
    this.el.classList.remove('is-waiting');
  }

  /** 物理是否冻结（只给 DEV 读数用）。 */
  isFrozen(): boolean {
    return this.frozen;
  }

  startDrag(): void {
    if (this.pooled || this.dragging || this.vanishing) return;
    this.dragging = true;
    this.el.classList.add('is-dragging');
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('is-dragging');
    // 参考站没有速度阈值：**松手就消散**。
    this.vanishing = true;
    this.el.classList.add('is-vanishing');
    this.vanishStart = performance.now();
  }

  isDragging(): boolean {
    return this.dragging;
  }

  isPooled(): boolean {
    return this.pooled;
  }

  /**
   * 把一个对象钉在确定状态上并冻住物理。
   *
   * **只给截图 / 回归测试用**（`?mwobjects=`）：正常路径上位置全部来自物理积分，
   * 而物理是时间相关的——headless 抓不到「同一帧」，没法比对改动前后的画面。
   */
  place(state: {
    x: number;
    y: number;
    z: number;
    scale: number;
    rx: number;
    ry: number;
    size: number;
  }): void {
    this.el.classList.remove('is-waiting', 'is-dragging', 'is-vanishing');
    // 顺手把消散的 seek 清掉：只有 DEV 的 `holdVanish()` 写过这两个行内属性，
    // 而 DEV 路径绝不会回收对象，所以在这里统一清是最省事的一处（不在热路径上）。
    this.el.style.animationDelay = '';
    this.el.style.animationPlayState = '';
    const inner = this.el.querySelector<HTMLElement>('.a__inner');
    if (inner) {
      inner.style.animationDelay = '';
      inner.style.animationPlayState = '';
    }
    this.pooled = false;
    this.dragging = false;
    this.vanishing = false;
    this.vanishStart = 0;
    this.pos = { x: state.x, y: state.y, z: state.z };
    this.rot = { x: state.rx, y: state.ry, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.scale = state.scale;
    this.frozen = true;
    this.pinned = true;
    this.el.style.setProperty('--size', String(state.size));
    this.write();
  }

  /**
   * DEV：把对象钉在「正在消散」的**确定一帧**上（`?mwvanish=1`）。
   *
   * 为什么不能只是加个 `is-vanishing` 就完事：`--screenshot` 是在
   * `--virtual-time-budget` 用完之后才抓帧的，而消散动画只有 0.75s，那时它早就跑完了
   * （`animation-fill-mode: both` 把它停在最后一帧 = 整个抹掉）。那只证明得了「东西不见了」，
   * 证明不了「30 帧精灵在一格一格扫」——恰恰后者才是这次要验的东西。所以这里把动画
   * **暂停 + seek 到指定进度**（负的 `animation-delay` 就是往前拨），截出来是半溶解的
   * 确定画面：既能和改前的图逐像素比对，又能用 `mask-position` 的读数确认遮罩真挂上了。
   *
   * 本体与卡面各挂一份遮罩（参考站就是这两个选择器并列），所以两边都要 seek。
   */
  holdVanish(frame: number): void {
    this.place({ x: 0, y: 0, z: -600, scale: 1, rx: 0, ry: 0, size: 1 });
    this.vanishing = true;
    this.vanishStart = performance.now();
    this.el.classList.add('is-vanishing');
    const offset = `${(-VANISH_ANIM_DURATION * frame).toFixed(3)}s`;
    for (const node of [this.el, this.el.querySelector<HTMLElement>('.a__inner')]) {
      if (!node) continue;
      node.style.animationDelay = offset;
      node.style.animationPlayState = 'paused';
    }
  }

  update(now: number): void {
    if (this.frozen) return;

    if (this.dragging) {
      const target = this.scene.dragTarget();
      this.vel.x += (target.x - this.pos.x) * 0.075;
      this.vel.y += (target.y - this.pos.y) * 0.075;
      this.vel.z += (0 - this.pos.z) * 0.3;

      this.rot.y = this.vel.x * 0.15;
      this.rot.x = this.vel.y * -0.15;
      this.rot.z = this.rot.y + this.rot.x;

      this.vel.x *= 0.9;
      this.vel.y *= 0.9;
      this.vel.z *= 0.75;

      this.pos.x += this.vel.x * 0.5;
      this.pos.y += this.vel.y * 0.5;
      this.pos.z = Math.min(this.pos.z + this.vel.z * 0.25, 500);
      this.scale += (1 - this.scale) * 0.5;
    } else if (this.vanishing) {
      this.vel.y += 0.5;
      this.pos.x += this.vel.x;
      this.pos.y += this.vel.y;
      this.rot.x += this.spin.x;
      this.rot.y += this.spin.y;
      if (now - this.vanishStart > VANISH_DELAY) {
        this.recycle();
        return;
      }
    } else if (this.pos.z > 1000) {
      this.recycle();
      return;
    } else {
      this.scale = Math.min(this.scale + 0.005, 1);
      this.pos.z += this.vel.z;
      this.pos.x += this.vel.x;
      this.pos.y += this.vel.y;
      this.rot.x += this.spin.x;
      this.rot.y += this.spin.y;
    }

    this.write();
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 场景本体：持有对象池、指针状态与每帧循环。 */
class MyWayScene {
  readonly element: HTMLElement;

  private readonly objects: WayObject[] = [];
  private readonly pool: WayObject[] = [];
  private readonly thrown: WayObject[] = [];
  private readonly objectLayer: HTMLElement;
  private readonly ruler: HTMLElement;
  private readonly catcher: HTMLElement;
  private readonly linesSvg: SVGSVGElement;
  private readonly radialPath: SVGPathElement;
  /** 自己盯住尺寸，见构造函数里的长注释。 */
  private readonly resizeObserver: ResizeObserver | null;

  /** DEV 钩子：非 null 时冻结滚动进度（`?mw=`）。 */
  private readonly frozenProgress: number | null = devScrollProgress;
  /** DEV 钩子：非 null 时按确定位置摆这么多对象并冻住物理（`?mwobjects=`）。 */
  private readonly frozenObjectCount: number | null = devObjectCount;
  /** DEV 钩子：非 null 时把第一个对象钉在消散动画的这个进度上（`?mwvanish=`）。 */
  private readonly vanishFrame: number | null = devVanish;
  /** DEV：确定位置是否已经摆过（要等第一次**真实**量尺寸之后才摆得准）。 */
  private devPlaced = false;

  private centerX = 0;
  private centerY = 0;
  private width = 1;
  private height = 1;

  private pointer = { x: 0, y: 0 };
  private smoothedPointer = { x: 0, y: 0 };
  private pointerReady = false;

  private scrollProgress = 0;
  private smoothedScroll = 0;

  private active = false;
  private canThrow = false;
  private lastThrow = 0;
  private throwDelay = 1400;
  private dragged: WayObject | null = null;

  constructor() {
    this.element = document.createElement('section');
    this.element.className = 's-my-way';

    // —— 笑脸（内联 SVG，CSS 让它自转） ——
    const smiley = document.createElementNS(SVG_NS, 'svg');
    smiley.classList.add('s__smiley');
    smiley.setAttribute('viewBox', '0 0 77.8 77.8');
    smiley.setAttribute('aria-hidden', 'true');
    const disc = document.createElementNS(SVG_NS, 'circle');
    disc.setAttribute('cx', '38.9');
    disc.setAttribute('cy', '38.9');
    disc.setAttribute('r', '38.9');
    // 圆底 + 脸：配色契约照参考站——`circle{fill:primary}` / `path{fill:secondary}`。
    const face = document.createElementNS(SVG_NS, 'path');
    face.setAttribute('d', SMILEY_PATH);
    smiley.append(disc, face);

    // —— 对象层 ——
    this.objectLayer = document.createElement('div');
    this.objectLayer.className = 's__objects js-objects';

    let parity = 0;
    const addFrame = (frame: MyWayFrame): void => {
      const { caption, ratio } = frame;
      const object = document.createElement('div');
      object.className = 'a-object a-object--frame';

      const figure = document.createElement('figure');
      figure.className = 'a__inner';
      const image = document.createElement('img');
      // 有真素材就走 src；没有则加 `--placeholder`，由 CSS 画一块主题色版画。
      // 两条路径的 DOM、尺寸、动画完全一致，换素材只改 content 里那一行 `src`。
      image.className = frame.src ? 'a__img' : 'a__img a__img--placeholder';
      image.alt = caption;
      image.loading = 'lazy';
      image.decoding = 'async';
      // 宽高属性按数据表里的比例给（参考站也写了真实像素），CSS 的 `height: auto`
      // 因此能算出高度；占位面另外把比例写成 `--ratio` 供 `aspect-ratio` 兜底。
      const longSide = 1024;
      image.width = ratio >= 1 ? longSide : Math.round(longSide * ratio);
      image.height = ratio >= 1 ? Math.round(longSide / ratio) : longSide;
      image.style.setProperty('--ratio', String(ratio));
      if (frame.src) image.src = frame.src;
      const figcaption = document.createElement('figcaption');
      figcaption.className = 'a__caption';
      figcaption.textContent = caption;
      figure.append(image, figcaption);

      const horizontal = document.createElement('div');
      horizontal.className = 'a__side a__side--horizontal';
      const vertical = document.createElement('div');
      vertical.className = 'a__side a__side--vertical';

      object.append(figure, horizontal, vertical);
      this.objectLayer.append(object);
      const wrapper = new WayObject(object, this, parity);
      parity += 1;
      this.objects.push(wrapper);
    };

    const addStar = (): void => {
      const object = document.createElement('div');
      object.className = 'a-object a-object--star';
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        const side = document.createElement('div');
        side.className = `a__side a__side--${corner}`;
        object.append(side);
      }
      // 星形不写 `--star`：贴图改由 CSS 的 `mask: url(/images/asset-star.svg)` 上，
      // 好处是形状照搬参考站、颜色跟着本站主题走（原站那张是写死的近黑色）。
      this.objectLayer.append(object);
      const wrapper = new WayObject(object, this, parity);
      parity += 1;
      this.objects.push(wrapper);
    };

    for (const frame of MY_WAY_FRAMES) addFrame(frame);
    for (let index = 0; index < MY_WAY_STAR_COUNT; index += 1) addStar();

    // 参考站从 `.s__ruler` 的实测高度推透视原点，所以这个尺子必须留着并接进 `this`。
    this.ruler = document.createElement('div');
    this.ruler.className = 's__ruler';
    this.objectLayer.append(this.ruler);

    // —— 底部四行大字（两份：斜切版 + 正常版） ——
    this.catcher = document.createElement('div');
    this.catcher.className = 's__catcher';
    const buildText = (variant: 'distorted' | 'normal'): HTMLElement => {
      const wrapper = document.createElement('div');
      wrapper.className = `s__catcher__${variant}-wrapper`;
      const inner = document.createElement('div');
      inner.className = `s__catcher__${variant}`;
      const text = document.createElement('div');
      text.className = `s__catcher__text s__catcher__text--${variant}`;
      for (const line of MY_WAY_LINES) {
        text.append(line, document.createElement('br'));
      }
      inner.append(text);
      wrapper.append(inner);
      return wrapper;
    };
    this.catcher.append(buildText('distorted'), buildText('normal'));

    // —— 从四周指向笑脸的放射线 ——
    const linesSvg = document.createElementNS(SVG_NS, 'svg');
    linesSvg.classList.add('s__svg');
    linesSvg.setAttribute('aria-hidden', 'true');
    this.radialPath = document.createElementNS(SVG_NS, 'path');
    this.radialPath.classList.add('s__svg__circular-path');
    linesSvg.append(this.radialPath);
    this.linesSvg = linesSvg;

    this.element.append(smiley, this.objectLayer, this.catcher, linesSvg);

    // 所有对象先入池，再由 `scatterInitial()` 取出来摆到场景里。
    this.pool.push(...this.objects);

    this.bindPointer();
    this.resize();
    // `?mwbg=` 只在 DEV 下有效（生产构建里 `devBackgroundCount` 是常量 null，被 DCE）。
    this.scatterInitial(devBackgroundCount ?? undefined);
    gsap.ticker.add(this.tick);

    /* 自己盯住自己的尺寸——**这一段不能依赖装配层来量**。
       构造函数会在「还没进文档」时跑一次 `resize()`，那时 `getBoundingClientRect()` 全是 0，
       于是 `--distortion`、放射线路径、透视原点都会停在退化值上；而 `sections/works.ts`
       只在窗口 resize 时才回调 `outro.resize()`（`applyLayout()` 里没有它），也就是挂载后
       没有任何人会来补量一次。表现就是四行大字的「碗状透视」整段失效（`--distortion`
       停在 0.14 而不是几百）、放射线退化成 1px。挂一个 ResizeObserver 就够：它在首次观测
       时就会带当前尺寸回调一次，此后尺寸变化也照常（比窗口 resize 更灵，还不用别人配合）。 */
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(this.element);

    /* —— DEV：截图 / 诊断通道（生产构建整段被 DCE 掉） ——
       `?mwobjects=` 先把对象摆到确定位置，`?mw=` 再把滚动进度钉住，两者都冻物理：
       headless 的 `--screenshot` 只能在「加载完的某一刻」抓帧，物理一直在跑的话每次
       截到的相位都不一样，没法比对。摆放要等第一次真实量尺寸——构造函数里那次量到的
       是 1×1，摆出来的对象会全部堆在正中，所以这件事交给 `resize()` 去做。 */
    if (this.frozenProgress !== null) this.syncScroll(true);

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__myWayDebug = {
        collect: () => this.collect(),
        setProgress: (value: number): void =>
          this.element.style.setProperty('--scroll-progress', value.toFixed(4)),
        placeObjects: (count: number): void => this.placeDevObjects(count),
        holdVanish: (frame = 0.5): void => this.holdDevVanish(frame),
      };
      // 等页面稳定再发读数：构造函数跑完时 `ResizeObserver`（补量几何）与
      // `sections/works.ts` 那个 `IntersectionObserver`（`setActive(true)` → 解冻）都还没回调，
      // 那时抓到的 `frozen` 计数是「进视口之前」的中间态，会误判。
      // `--virtual-time-budget` 会把这 700ms 一并快进，所以不会拖慢截图。
      if (devParams?.has('sink')) {
        window.setTimeout(() => this.beacon(this.collect()), 700);
      }
    }
  }

  // —— 对外 ——

  setActive(active: boolean): void {
    const entering = active && !this.active;
    this.active = active;
    this.canThrow = active;
    if (active) {
      // 刚入视口先把滚动进度吸附到位，避免从上一次的陈旧值补间（见 syncScroll）。
      if (entering) {
        // 顺带补量一次：ResizeObserver 已经兜住了，但这一次成本为零，还能保证
        // 「即将进入视口」这一帧的几何一定是最新的（字体加载完 / 前面板块高度变过等）。
        this.resize();
        this.syncScroll(true);
      }
      for (const object of this.thrown) object.revive();
    }
  }

  resize(): void {
    const rect = this.element.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);

    const smiley = this.element.querySelector<SVGElement>('.s__smiley');
    const smileyRect = smiley?.getBoundingClientRect();
    if (smileyRect && smileyRect.width > 0) {
      this.centerX = smileyRect.left - rect.left + smileyRect.width / 2;
      this.centerY = smileyRect.top - rect.top + smileyRect.height / 2;
    } else {
      this.centerX = this.width / 2;
      this.centerY = this.height / 2;
    }

    // 折角量：参考站 `hypot(width, (height − smileyY) / 2) * 0.14`，喂给 CSS 做透视。
    const distortion = Math.hypot(this.width, (this.height - this.centerY) / 2) * 0.14;
    this.element.style.setProperty('--distortion', distortion.toFixed(3));

    // 透视原点：参考站读 `.s__ruler` 的**实测高度**（`setSize()` 里 `ruler.clientHeight`）。
    // 这个值是**对象层坐标**——对象层 `top/bottom: -100vh`，比板块本身高 200vh，
    // 所以绝不能拿 `this.height` 去算（那会让原点整体上移一屏，深度落点全偏）。
    // 兜底：板块还没进文档时 `clientHeight` 为 0，此时按 CSS 的公式反推一个近似值。
    const rulerHeight = this.ruler.clientHeight;
    let originY = rulerHeight;
    if (rulerHeight <= 0) {
      const padding = Number.parseFloat(
        getComputedStyle(this.element).getPropertyValue('--padding') || '0',
      );
      // `--padding` 是 rem，换算要读根字号，别硬写 16（用户可能改过根字号）。
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize || '16',
      );
      const paddingPx = Number.isFinite(padding) ? padding * (rootFontSize || 16) : 0;
      originY = this.objectLayer.clientHeight / 2 - paddingPx * RULER_FALLBACK_RATIO;
    }
    this.objectLayer.style.perspectiveOrigin = `50% ${originY.toFixed(1)}px`;

    this.drawLines();

    // DEV：等第一次**真实**量到尺寸之后，再把对象摆到确定位置（构造函数那次量到的是 1×1）。
    if (!this.devPlaced && this.width > 1 &&
      (this.frozenObjectCount !== null || this.vanishFrame !== null)) {
      this.devPlaced = true;
      if (this.frozenObjectCount !== null) this.placeDevObjects(this.frozenObjectCount);
      if (this.vanishFrame !== null) this.holdDevVanish(this.vanishFrame);
    }
  }

  dispose(): void {
    gsap.ticker.remove(this.tick);
    this.resizeObserver?.disconnect();
    this.element.remove();
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__myWayDebug;
    }
  }

  // —— DEV：读数与冻帧（生产构建里 `import.meta.env.DEV` 为 false，整段被 DCE 掉） ——

  /**
   * 把读数发给本机诊断汇（`.workbuddy/tmp/sink.mjs`）。
   *
   * 与 `sections/works.ts` 同一套理由：headless 下这是唯一能拿回**纯文本**的通道
   * （DevTools 两条端点在这台机器上全废），而且像素会骗人（合成帧滞后、视口漂移），
   * 所以判读一律以这份文本为准、图片只作旁证。
   */
  private beacon(payload: Record<string, unknown>): void {
    try {
      const port = devParams?.get('sink') ?? '9099';
      navigator.sendBeacon(`http://127.0.0.1:${port}/probe`, JSON.stringify(payload));
    } catch {
      /* 没开 sink 时静默——这本就是可选的调试通道 */
    }
  }

  /** 采集一次读数：几何、透视原点、射线段数、对象分布、四行大字的进度。 */
  private collect(): Record<string, unknown> {
    const box = (element: Element): string => {
      const rect = element.getBoundingClientRect();
      return `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
    };
    const d = this.radialPath.getAttribute('d') ?? '';
    const ratios = [...this.element.querySelectorAll<HTMLImageElement>('.a-object--frame .a__img')]
      .map((image) => image.style.getPropertyValue('--ratio'))
      .join(',');

    return {
      section: 's-my-way',
      query: window.location.search,
      scrollY: Math.round(window.scrollY),
      innerH: window.innerHeight,
      box: box(this.element),
      scrollProgress: this.element.style.getPropertyValue('--scroll-progress'),
      distortion: this.element.style.getPropertyValue('--distortion'),
      smileyCenter: `${Math.round(this.centerX)},${Math.round(this.centerY)}`,
      layer: `h=${this.objectLayer.clientHeight} origin=${this.objectLayer.style.perspectiveOrigin}`,
      // 对象层上下各外扩 100vh——去掉 `overflow: hidden` 之后，这一层能不能把内容画到
      // 板块框外（也就是「物体从上方飞入」还在不在），靠这个盒子和 section 的盒子比对。
      layerBox: box(this.objectLayer),
      ruler: `h=${this.ruler.clientHeight} css=${getComputedStyle(this.ruler).height}`,
      lines: `${(d.match(/M/g) ?? []).length} 段 · head=${d.slice(0, 30)}`,
      objects: `${this.element.querySelectorAll('.a-object--frame').length} 框 + ` +
        `${this.element.querySelectorAll('.a-object--star').length} 星 · ` +
        // `frozen` 必须为 0：段落一进视口 `revive()` 就该把 `thrown` 全部解冻。
        // 修复前这里恒为 `frozen=2` 且永不变化（背景对象被永久冻住），是最直接的判据。
        `thrown=${this.thrown.length}(frozen=${this.thrown.filter((o) => o.isFrozen()).length})`,
      // `?mwvanish=1` 的验收项：遮罩图确实解析成了精灵文件、尺寸是 3000%、
      // 位置被 seek 到了半程（不是停在 `0%` 上），而且动画是暂停的（可重复截同一帧）。
      vanish: ((): string => {
        const node = this.element.querySelector<HTMLElement>('.a-object.is-vanishing');
        if (!node) return 'none';
        const style = getComputedStyle(node);
        const file = (style.maskImage || style.webkitMaskImage || '').split('/').pop() ?? '';
        return `mask=${file} size=${style.maskSize || style.webkitMaskSize} ` +
          `pos=${style.maskPosition || style.webkitMaskPosition} ` +
          `play=${style.animationPlayState} delay=${style.animationDelay}`;
      })(),
      // 星形的贴图挂在伪元素上（`.a-object--star::before/::after`），所以读数要带第二个参数。
      starMask: ((): string => {
        const node = this.element.querySelector<HTMLElement>('.a-object--star');
        if (!node) return 'none';
        const style = getComputedStyle(node, '::before');
        const file = (style.maskImage || style.webkitMaskImage || '').split('/').pop() ?? '';
        return `mask=${file} size=${style.maskSize || style.webkitMaskSize} ` +
          `repeat=${style.maskRepeat || style.webkitMaskRepeat} ` +
          `bg=${style.backgroundColor}`;
      })(),
      frameRatios: ratios,
      // 去掉 `overflow: hidden` 后最怕的就是横向滚动条，所以这一项每次都量。
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sectionOverflow: getComputedStyle(this.element).overflow,
    };
  }

  /**
   * DEV：把前 `count` 个对象摆到确定位置并冻住物理（`?mwobjects=`）。
   *
   * 位置是**解析式**的，同一组参数每次截出来的画面一致，可以拿来做改动前后的逐像素比对。
   * 深度从 −400（近，透视后约 0.7 倍）铺到 −11400（远，约 0.08 倍）——这个区间是照
   * 物理本身的样子挑的：正常运行时对象就是从 `z = −2e4` 一路飞到镜头前，所以画面上
   * 永远同时有「一块大的 + 几块远的」。倾角给得小（±20° 内），免得相框被压成薄片、
   * 看不出是相框。
   *
   * `count` 给**负数**表示从队伍末尾往前摆：末尾那 10 个是星形（相框在前），
   * 这样 `?mwobjects=-10` 就能把一颗星放到最近处，专门验星形贴图。
   */
  private placeDevObjects(count: number): void {
    const fromTail = count < 0;
    const total = Math.max(1, Math.min(Math.abs(Math.round(count)), this.objects.length));
    for (let slot = 0; slot < total; slot += 1) {
      const object = fromTail
        ? this.objects[this.objects.length - 1 - slot]
        : this.objects[slot];
      if (!object) continue;
      const u = total === 1 ? 0.5 : slot / (total - 1);
      this.adoptDevObject(object);
      object.place({
        x: (u - 0.5) * this.width * 0.8,
        y: (slot % 2 === 0 ? -0.18 : 0.18) * this.height,
        z: -400 - u * 11000,
        scale: 0.55 + u * 0.45,
        rx: (slot % 2 === 0 ? -1 : 1) * (5 + (slot % 4) * 4),
        ry: ((slot % 3) - 1) * 18,
        size: 0.5 + (slot % 4) * 0.16,
      });
    }
  }

  /** DEV：把第一个对象钉在消散动画的 `frame`（0~1）处（`?mwvanish=`），细节见 `WayObject.holdVanish()`。 */
  private holdDevVanish(frame: number): void {
    const object = this.objects[0];
    if (!object) return;
    this.adoptDevObject(object);
    // 0 = 完全没消（原样），1 = 整张抹掉。两端都要能取到，A/B 才有意义。
    object.holdVanish(Math.min(1, Math.max(0, frame)));
  }

  /** 把对象从池里摘出来并标成「已甩出」，免得之后的 `throwObject()` 又抽中它改写状态。 */
  private adoptDevObject(object: WayObject): void {
    if (!this.thrown.includes(object)) this.thrown.push(object);
    const pooled = this.pool.indexOf(object);
    if (pooled >= 0) this.pool.splice(pooled, 1);
  }

  // —— 对象池协作 ——

  onObjectRecycled(object: WayObject): void {
    const index = this.thrown.indexOf(object);
    if (index >= 0) this.thrown.splice(index, 1);
    if (!this.pool.includes(object)) this.pool.push(object);
    if (this.dragged === object) this.dragged = null;
  }

  /** 拖拽目标：指针相对笑脸中心的偏移。 */
  dragTarget(): { x: number; y: number } {
    return {
      x: this.smoothedPointer.x - this.centerX,
      y: this.smoothedPointer.y - this.centerY * 1.5,
    };
  }

  // —— 内部 ——

  /**
   * 段落刚出现时先在场景里摆 2~5 个当背景。
   *
   * 它们不是「永久背景」：`setActive(true)` 会调 `revive()` 把它们解冻，
   * 随即和别的对象一样飞向镜头（这才是参考站的行为，见 `revive()` 的注释）。
   *
   * 两处细节都照参考站 `firstObjects()` 写：
   *   - 数量基准用 `window.innerWidth`，**不是 `this.width`**。本函数在构造函数里执行，
   *     那时元素还没进文档、`resize()` 量到 0 → `this.width` 恒为 1 →
   *     `Math.round(1 * 0.025) = 0` → 被下限兜成固定 **2** 个，与视口无关。
   *   - 从池里**随机抽**，不是 `pop()`。池的顺序是「16 个相框在前、10 个星在后」，
   *     `pop()` 必定抽中尾巴上的星 → 背景里永远只有星。
   */
  private scatterInitial(override?: number): void {
    const count = override ?? Math.max(2, Math.min(5, Math.round(window.innerWidth * 0.025)));
    if (count <= 0) return;
    for (let index = 0; index < count; index += 1) {
      const [object] = this.pool.splice(Math.floor(Math.random() * this.pool.length), 1);
      if (!object) break;
      object.reset(false);
      this.thrown.push(object);
    }
  }

  private throwObject(): void {
    if (this.thrown.length < MAX_THROWN && this.pool.length > 0) {
      const object = this.pool.splice(Math.floor(Math.random() * this.pool.length), 1)[0];
      if (object) {
        object.reset(true);
        this.thrown.push(object);
      }
    }
    this.lastThrow = performance.now();
    const factor = window.innerWidth > 767 ? 1.25 : 2;
    this.throwDelay = (500 + Math.random() * 500) * factor;
  }

  private bindPointer(): void {
    const update = (clientX: number, clientY: number): void => {
      const rect = this.element.getBoundingClientRect();
      this.pointer.x = clientX - rect.left;
      this.pointer.y = clientY - rect.top;
      if (!this.pointerReady) {
        this.smoothedPointer = { ...this.pointer };
        this.pointerReady = true;
      }
    };

    window.addEventListener('pointermove', (event) => update(event.clientX, event.clientY), {
      passive: true,
    });

    this.objectLayer.addEventListener('pointerdown', (event) => {
      const target = (event.target as HTMLElement | null)?.closest('.a-object');
      if (!target) return;
      const object = this.thrown.find((candidate) => candidate.el === target);
      if (!object) return;
      event.preventDefault();
      update(event.clientX, event.clientY);
      event.stopPropagation();
      this.objectLayer.setPointerCapture(event.pointerId);
      object.startDrag();
      this.dragged = object;
    });

    const release = (): void => {
      if (!this.dragged) return;
      this.dragged.endDrag();
      this.dragged = null;
    };
    this.objectLayer.addEventListener('pointerup', release);
    this.objectLayer.addEventListener('pointercancel', release);
    this.element.addEventListener('pointerup', release);
  }

  /**
   * 画「汇聚到笑脸」的放射线。
   *
   * 照参考站 `setLines()` 的算法：以视口宽度切出 12（窄屏 8）列，**每一列**从顶边和底边
   * 各射出一条线指向笑脸中心；行数取同一个数，再从左右两边各射一组；另外底边整条横线
   * 打头（它在参考站里是 `drawLines()` 的起手式）。1440 宽下是 1 + 13×2 + 11×2 = **49 段
   * 子路径**。纯装饰，但它是这一屏最显眼的几何，别改回「围一圈小刻度」。
   *
   * 坐标单位 = CSS px：`viewBox` 与元素尺寸同步更新，所以 1 单位就是 1px，与参考站直接写
   * `svg.style.width/height` 的做法等价。
   */
  private drawLines(): void {
    const { centerX: cx, centerY: cy, width, height } = this;

    const cols = window.innerWidth > 767 ? LINES_COLS_DESKTOP : LINES_COLS_COMPACT;
    const colWidth = width / cols;

    let d = `M0 ${height}L${width} ${height}`;
    for (let index = 0; index <= cols; index += 1) {
      const x = colWidth * index;
      d += `M${x} 0L${cx} ${cy}`;
      d += `M${x} ${height}L${cx} ${cy}`;
    }

    // 行数与列数相同；行距的余量上下均分（参考站 `h = (height − rowHeight * rows) / 2`）。
    const rows = cols;
    const rowHeight = height / rows;
    const top = (height - rowHeight * rows) / 2;
    for (let index = 1; index < rows; index += 1) {
      const y = top + rowHeight * index;
      d += `M0 ${y}L${cx} ${cy}`;
      d += `M${width} ${y}L${cx} ${cy}`;
    }

    this.radialPath.setAttribute('d', d);
    this.linesSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  /**
   * 量一次滚动进度并写 `--scroll-progress`。
   *
   * 参考站 s-my-way 写的是**插值后**的值（`sp += (p − sp) * 0.1`），而 s-work 写原始
   * 值——这两段在这一点上并不一致，这里照搬 s-my-way 的行为（见 styles.css 里
   * 「碗状透视」那四行大字）。
   *
   * `snap` 用于刚进入视口时：直接把插值状态吸附到目标值。否则会从上一次离开视口时
   * 留下的陈旧值开始补间，表现为「刚露头时四行大字先错位、再慢慢归位」。
   */
  private syncScroll(snap = false): void {
    // DEV 冻帧：直接把 `--scroll-progress` 钉在 URL 给的值上，不读布局（截图脚本用）。
    if (this.frozenProgress !== null) {
      this.element.style.setProperty('--scroll-progress', this.frozenProgress.toFixed(4));
      return;
    }

    const rect = this.element.getBoundingClientRect();
    const span = window.innerHeight + rect.height;
    this.scrollProgress = span > 0 ? Math.min(1, Math.max(0, (window.innerHeight - rect.top) / span)) : 0;
    if (snap) this.smoothedScroll = this.scrollProgress;
    this.smoothedScroll += (this.scrollProgress - this.smoothedScroll) * SCROLL_LERP;
    this.element.style.setProperty('--scroll-progress', this.smoothedScroll.toFixed(4));
  }

  private tick = (): void => {
    const now = performance.now();

    // 鼠标插值：拖拽因此带黏滞。纯算术、不读布局，放在门控之前无妨。
    this.smoothedPointer.x += (this.pointer.x - this.smoothedPointer.x) * MOUSE_LERP;
    this.smoothedPointer.y += (this.pointer.y - this.smoothedPointer.y) * MOUSE_LERP;

    // 门控必须在 `syncScroll()` 之前：后者要 `getBoundingClientRect()`，而 gsap.ticker
    // 从页面首帧起就一直跑——本段不在视口时没必要每帧强制一次同步布局。
    if (!this.active) return;

    this.syncScroll();

    // 冻帧（`?mwobjects=`）：对象已按确定位置摆好，别再跑物理，否则每次截到的相位都不同。
    if (this.frozenObjectCount !== null) return;

    for (const object of this.thrown) object.update(now);
    if (this.canThrow && now - this.lastThrow > this.throwDelay) this.throwObject();
  };
}

/** 建好整块结尾场景（笑脸 + 对象池 + 四行大字）并开始跑物理。 */
export function createMyWay(): MyWayHandle {
  return new MyWayScene();
}
