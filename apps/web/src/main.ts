import './styles.css';
// ⚠️ 顺序有讲究：账号页 / 公开主页的样式必须排在 `styles.css` 之后，同权重时后者胜出。
import './account/account.css';
import { APP_ROUTES, isNavRoute, type AppRoute } from './app-routes';
import { getAuthState, hydrate, logout, markGuest, rememberReturnTo, startAuthSync, subscribe } from './auth/session';
import { createNavbar } from './components/navbar';
import { createAboutPage } from './pages/about';
import { createAccountPage, parseAccountTab } from './pages/account';
import { createAuthPage } from './pages/auth';
import { createBlogPage } from './pages/blog';
import { createHomePageView } from './pages/home-view';
import { createMessagePage } from './pages/message';
import { createPublicProfilePage } from './pages/public-profile';
import { createWorkDetailPage } from './pages/work-detail';
import { createWorksPage } from './pages/works';
import { attachHeroParallax } from './scene/hero-parallax';
import { initSmoothScroll } from './scene/smooth-scroll';
import { forceReducedMotion, whenFontsReady } from './scene/text-support';
import { createRouter, type RouteView } from './router';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Root element "#app" was not found in index.html');
}

/**
 * 路由 id：五个导航项 + 三个不在导航栏里的页面（`#login` / `#account/…` / `#u/…`）。
 * 真源在 `app-routes.ts`——别在这里手抄一份。
 */
type Route = AppRoute;

const shell = document.createElement('div');
shell.className = 'app-shell';

// 接管滚动的 Lenis 建在**页面视图之前**：WORK 段的「跳过」胶囊与页脚的「回到顶部」胶囊都要
// 借它做长距离缓动滚动，句柄以 options 注入各 section（见各自 `scrollTo` 选项）；换页面时的
// 滚动复位也走它（直接 `window.scrollTo` 会被它的下一帧拽回内部目标值）。
// **为什么顺序安全**：① Lenis 1.x 构造时对 wrapper / content 各挂一个 ResizeObserver，
// 文档还没长出来时会自己补量（每次换视图后的 `smooth.refresh()` 照旧兜底）；
// ② 前两屏的滚动锁靠运行期的 MutationObserver 挂在 body 上，与创建先后无关；
// ③ work-stage 那条 ScrollTrigger 用的是默认 scroller（window），而 Lenis 默认模式驱动的
//    正是真实 `scrollTop`，两者不抢。
const smooth = initSmoothScroll();

/**
 * 视图工厂。
 *
 * 这里刻意用 `Route` 而不是字符串做键——路由表、视图工厂共用同一份 id
 * （`APP_ROUTES`），任何一处删掉一项，TS 都会在这里报出来（穷尽 switch + 返回类型）。
 *
 * `param` 是地址栏第二段：`#works/<slug>` 是作品详情，`#login/register` 是注册 tab，
 * `#account/<tab>` 是账号子页。这样三个导航项各自承载多级页面，导航高亮不用做两套。
 */
const createView = (route: Route, param: string | null): RouteView => {
  switch (route) {
    case 'home':
      return createHomePageView({ scrollTo: smooth.scrollTo });
    case 'works':
      return param ? createWorkDetailPage({ slug: param }) : createWorksPage();
    case 'blog':
      return createBlogPage();
    case 'message':
      return createMessagePage();
    case 'about':
      return createAboutPage();
    case 'login':
      return createAuthPage({
        mode: param === 'register' ? 'register' : 'login',
        navigate: router.navigate,
        scrollTo: smooth.scrollTo,
      });
    case 'account':
      return createAccountPage({ tab: parseAccountTab(param), navigate: router.navigate });
    case 'u':
      /*
       * 公开主页。`param` 是用户名（`#u/MnO4_`）——它**不是导航项**，所以导航胶囊会被清掉。
       * 用户名的大小写、非法字符都交给服务端判定：前端先猜一遍只会多出第二套规则。
       */
      return createPublicProfilePage({ username: param ?? '', navigate: router.navigate });
  }
};

const router = createRouter<Route>({
  routes: APP_ROUTES,
  fallback: 'home',
  container: shell,
  createView,
  onChanged: (route, previous, change) => {
    // 登录页 / 账号页不属于任何导航项，传 null 让胶囊收起来（见 `setActive` 的说明）。
    navbar.setActive(isNavRoute(route) ? route : null);
    // 给 CSS / 调试用：`html[data-route="blog"]`。截图脚本也靠它判断当前落在哪一页。
    document.documentElement.dataset.route = route;
    // 详情页再加一层 `html[data-work="<slug>"]`：同一路由下参数不同，只看 data-route 分不出来。
    if (change.param) document.documentElement.dataset.work = change.param;
    else delete document.documentElement.dataset.work;
    // 公开主页同理：`html[data-profile="<用户名>"]`（调试与截图脚本用）。
    if (route === 'u' && change.param) document.documentElement.dataset.profile = change.param;
    else delete document.documentElement.dataset.profile;
    // 只有「换页」才把滚动复位到页顶（首屏 `previous === null` 时不碰：浏览器可能刚恢复了
    // 刷新前的位置，一进来就拉回页顶会显得很跳）。`immediate` 是因为新视图的高度还没被
    // 量过，插值滚动会停在旧文档高度算出来的位置上。
    if (previous !== null) {
      smooth.scrollTo(0, { immediate: true });
    }
    smooth.refresh();
  },
});

/**
 * 导航栏是**全站单例**：换页面不该重播它的入场动画，滑动胶囊也要能跨页停在同一项上。
 * 它先于视图挂进 `.app-shell`，所以永远是第一个子元素（视图按路由 append 在它后面）。
 */
const navbar = createNavbar({
  activeId: isNavRoute(router.current) ? router.current : null,
  account: getAuthState(),
  onSelect: (id) => {
    // 「点当前这一项」有两层含义，必须区分开：
    //   · 已经在列表页（param 为 null）→ 当作「回到页顶」，不然点了完全没反应；
    //   · 在作品详情页（param 有值）→ 应当回列表，而不是滚到详情页顶部。
    if (id === router.current && router.param === null) {
      smooth.scrollTo(0, { duration: 0.8 });
      return;
    }
    router.navigate(id);
  },
  // 点「登录 / 注册」时地址栏还是原页面——错过这一刻就再也拿不回落点了。
  onRememberReturnTo: rememberReturnTo,
  onLogout: () => {
    void logout().then(() => {
      // 站内的账号页在退登后只剩「请先登录」，留在那儿没意义。
      if (router.current === 'account') router.navigate('home');
    });
  },
});

shell.append(navbar.element);
root.append(shell);

/*
 * DEV 截图：`?rm=1` 强制「减少动态」。
 *
 * `identity` 与 `skills` 一进视口就会冻结 body 滚动播入场动画，而 headless 的
 * `--screenshot` 既不能滚也拍不到动画结束后的一帧；这两个板块在「减少动态」下本来
 * 就会直接落到终态，用这个参数借用同一条路径。
 *
 * **必须在 `router.start()` 之前**：两个板块都在 `createXxx()` 里就把
 * `prefersReducedMotion()` 读进局部变量了，晚一步改就无效。
 */
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('rm') === '1') {
  forceReducedMotion();
}

// 首个视图与 hashchange 监听都在这里同步挂上。**必须在下面的 DEV 探针之前**：headless 的
// `--screenshot` 就在 `load` 附近抓帧，靠定时器补会拍到空画面。
router.start();

/*
 * 登录态：**必须等首个视图挂完之后再问后端**（上面那条纪律），所以这里是异步的。
 *
 * 为什么首帧不会闪成游客：`.site-header__inner` 在 `is-ready` 之前是 `visibility: hidden`
 * （rAF + 120ms 兜底才显形），而本机 `/api/auth/session` 通常 10~20ms 就回来了；
 * 账号位在 `data-state="unknown"` 时另外还有一条 `visibility: hidden` 兜底。
 * **不**为了省这十几毫秒去把 token 镜像到 localStorage——HttpOnly 的边界比一帧更重要。
 */
subscribe((state) => {
  navbar.setAccount(state);
});
startAuthSync();

// 截图 / 预览模式（`?wp=` / `?cta=1` / `?probe=` / `?shot=` / `?rm=1`）不查会话：headless 在
// `load` 附近抓帧，结果必须是确定的游客态，不能取决于那一刻浏览器里有没有 cookie。
const shotMode = ['wp', 'cta', 'probe', 'shot', 'rm'].some((key) =>
  new URLSearchParams(window.location.search).has(key),
);
if (shotMode) markGuest();
else void hydrate();

// 参考站用 Lenis 默认参数接管滚动（`lerp: 0.1`），我们照抄。它会自己避让前面两屏的
// 滚动锁（见 scene/smooth-scroll.ts），所以各视图一行都不用改。
void whenFontsReady().then(() => smooth.refresh());

// 首屏字标与导航栏的滚动节奏。挂在**全局**而不是首页视图里：它把 `--hero-*` / `--header-*`
// 写在根节点上，而这些变量只在「算过」之后才会被清掉——如果它只活在首页，从首页滚到很深处
// 再切到别的标签页，导航栏会一直保持收起状态（透明度与缩放停在离场值上）。
attachHeroParallax();

// DEV 探针：截图脚本要通过 Lenis 滚动（直接 `window.scrollTo` 会被它下一帧拽回
// 内部目标值），所以把句柄挂出去。生产构建里整段会被 DCE 掉。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__smooth = smooth;
  (window as unknown as Record<string, unknown>).__router = router;
  // `?route=<id>`：装配完再走一遍**真实的换页路径**（点标签页走的就是它）。
  // 为什么需要它：headless 只有 `--dump-dom` 一条通道，没有这个参数就只能验「首屏落在哪一页」，
  // 验不了「换页」——而换页恰恰是最容易留下旧视图/漏掉 dispose 的地方。
  const devQuery = new URLSearchParams(window.location.search);
  const devRoute = devQuery.get('route');
  if (devRoute && (APP_ROUTES as readonly string[]).includes(devRoute)) {
    // `?route=works&work=<slug>` 直达作品详情；`?route=login&param=register` 直达注册 tab。
    const devParam = devQuery.get('param') ?? devQuery.get('work');
    router.navigate(devRoute as AppRoute, devParam);
  }
  // 截图模式（URL 带 ?wp= / ?probe=）下，立刻同步落到指定状态——必须在 `load` 之前，
  // 因为 headless 的 `--screenshot` 就在 load 附近抓帧，等定时器会抓到空画面。
  // 由 `sections/works.ts` 挂上，只有首页视图会建它。
  (window as unknown as { __shotApply?: () => void }).__shotApply?.();

  /*
   * `?shot=<home|about|skills>`：只留下一个板块，其它兄弟全部 `display:none`。
   *
   * 为什么需要：`--screenshot` 只能拍文档前一个视口高度的内容，而这两屏都在首屏之下，
   * 不给钩子就永远拍不到。做法与 `sections/works.ts` 的 `is-shot-mode`、
   * `sections/cta.ts` 的 `is-cta-shot` 完全同构（都是 `html.is-xxx` + `.app-shell > *`），
   * 前提也一样：**首页各板块必须始终是 `.app-shell` 的直接子元素**。
   *
   * 配合 `?rm=1` 使用：那一步让板块走「减少动态」的终态分支，这一步负责把它挪到视口里。
   */
  const shotSection = devQuery.get('shot');
  const SHOT_TARGETS: Record<string, string> = {
    home: 'home',
    about: 'identity',
    skills: 'skills',
  };
  const shotTarget = SHOT_TARGETS[shotSection ?? ''];
  if (shotTarget) {
    const style = document.createElement('style');
    style.id = '__section-shot';
    style.textContent = [
      // 用 `:not()` 而不是「先全隐再单独 display:block」——后者会把板块自己的
      // `display: flex/grid` 一起改掉（`.home` 就是 flex 居中布局，改成 block 会跑到左上角）。
      // 导航栏是站点外壳，截图里留着更像真站点。
      `html.is-section-shot .app-shell > *:not(.${shotTarget}):not(.site-header) {`,
      '  display: none !important; }',
      // 终态要靠 CSS 兜住：关掉所有过渡/动画，避免拍到「最近一次已提交的合成帧」
      'html.is-section-shot *, html.is-section-shot *::before, html.is-section-shot *::after {',
      '  transition: none !important; animation: none !important; will-change: auto !important; }',
      // 首屏的入场是「初始 opacity: 0 + 一次性 keyframes / transition」，而动画在 headless
      // 里不随虚拟时间推进（实测 3s 与 9s 拍到同一帧）。关掉动画后基线仍是 0，所以这里
      // 直接把三件套按到终态。
      'html.is-section-shot .hero__title-stage,',
      'html.is-section-shot .hero__tagline,',
      'html.is-section-shot .hero__ground {',
      '  opacity: 1 !important; transform: none !important; }',
    ].join('\n');
    document.head.append(style);
    document.documentElement.classList.add('is-section-shot');
  }
}

// Adding `is-ready` on the next frame lets the initial styles paint first, so
// the navbar and hero animate in instead of appearing fully formed. The timer
// fallback covers backgrounded tabs, where `requestAnimationFrame` is paused.
const revealShell = (): void => {
  shell.classList.add('is-ready');
};
requestAnimationFrame(revealShell);
window.setTimeout(revealShell, 120);
