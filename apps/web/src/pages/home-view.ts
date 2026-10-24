/**
 * 首页视图：首屏字标 → 「我是谁？」→「我会什么？」→ WORK 段 →「Let's Rock」圆盘 + 页脚。
 *
 * 这些板块原本直接长在 `main.ts` 里；加了标签页路由之后，它们必须能整块建起来、也能整块
 * 拆掉（`RouteView`），所以搬到这里。三件与「谁在什么时候建」有关的事：
 *
 *   1. **枫叶画布放在 `mounted()` 里建**：它的构造函数就把画布挂到 `body` 上，而首帧的碰撞
 *      面要读字标与地板的 rect——`createView()` 阶段这些节点还没进文档，量出来全是 0。
 *   2. **导航栏不在这里**：它是全站单例（换页面不该重播入场动画），由 `main.ts` 挂在
 *      `.app-shell` 上，永远排在本视图前面。
 *   3. **dom 顺序 = 视觉顺序**：`elements` 按数组顺序 append，所以 `.s-work` 的 `z-index: 4`
 *      那条刻意的层叠（见 `styles.css`）依赖的顺序没有被改动。
 */

import { createHomePage } from './home';
import { createCtaSection } from '../sections/cta';
import { createIdentitySection } from '../sections/identity';
import { createSkillsSection } from '../sections/skills';
import { createWorksSection } from '../sections/works';
import { createLeafField } from '../scene/leaf-field';
import type { ScrollToController } from '../scene/smooth-scroll';
import type { RouteView } from '../router';
import { fetchWorks } from '../works/api';
import { toWallCards } from '../works/present';
import type { WorkCardContent } from '../content/works';

export interface HomePageViewOptions {
  /**
   * Lenis 的滚动入口（`smooth.scrollTo`，由 `main.ts` 注入）。
   *
   * 这里收的是**函数**而不是整个 `SmoothScrollHandle`：视图没有任何理由去 `stop()` /
   * `destroy()` 平滑滚动，窄接口也让 jsdom 回归里能塞一个假句柄（见 `dom-test.mjs`）。
   */
  scrollTo: ScrollToController['scrollTo'];
}

export function createHomePageView(options: HomePageViewOptions): RouteView {
  // “我是谁？”板块接在首屏之后；点阵飞入用的画布是 fixed 的，所以点可以从整屏
  // 之外飞进来而不被相框裁掉。
  const identity = createIdentitySection({
    portraitSrc: './portrait',
    portraitWidths: [512, 1024],
  });

  const home = createHomePage();

  // “我会什么？”接在“我是谁？”之后：浅绿底上的光球 + 先画一张牌再散成扇形 + 粒子团。
  const skills = createSkillsSection();

  // “作品”接在“我会什么？”之后：二进制分隔带 → 钉住的大字 WORK + 卡片依次横穿
  // → 结尾区块（笑脸 + 可拖拽甩出的 3D 盒子 + 四行大字）。结构与时间轴照搬
  // wodniack.dev 的 WORK 段，配色沿用本站浅绿主题。
  //
  // 卡片内容来自真实作品（`GET /api/works`）。数据是异步的，而这里必须同步建完首屏，
  // 所以先铺 34 张占位卡，数据到了由 `setCards()` 热替换；接口挂了就一直是占位墙。
  const worksAbort = new AbortController();
  const cardsPromise: Promise<readonly WorkCardContent[]> = fetchWorks(worksAbort.signal)
    .then((result) => toWallCards(result.works))
    .catch(() => []);

  const works = createWorksSection({ scrollTo: options.scrollTo, cardsPromise });

  // 页面最后是「Let's Rock」圆盘 + 页脚（参考站 wodniack.dev 的 s-cta / site-foot）。
  // 与 `.works` 同级挂在 shell 下，所以 works 的截图模式（`html.is-shot-mode .app-shell > *`）
  // 会把它一并隐藏，两段的 DEV 钩子互不干扰。
  const cta = createCtaSection({ scrollTo: options.scrollTo });

  let disposeLeafField: (() => void) | null = null;

  return {
    elements: [home.section, identity.element, skills.element, works.element, cta.element, cta.footer],
    mounted: () => {
      disposeLeafField = createLeafField({
        host: document.body,
        title: home.title,
        ground: home.ground,
        scene: home.section,
      });
    },
    dispose: () => {
      // 先取消在途请求：视图都要拆了，没必要再等一次响应回来触发 setCards。
      worksAbort.abort();
      // 先停逐帧读 rect 的东西（画布），再拆板块——反过来的话枫叶会对着已被摘掉的
      // 节点量最后几帧。
      disposeLeafField?.();
      disposeLeafField = null;
      identity.dispose();
      skills.dispose();
      works.dispose();
      cta.dispose();
    },
  };
}
