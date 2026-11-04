import './styles.css';
// ⚠️ 顺序有讲究：账号页 / 公开主页 / 博客 / 留言板 / 关于我的样式必须排在 `styles.css` 之后，
// 同权重时后者胜出。
import './account/account.css';
import './blog/blog.css';
import './message/message.css';
import './pages/about.css';
import './pages/photo.css';
import { isNavRoute, routesForSite, type AppRoute } from './app-routes';
import { getAuthState, hydrate, logout, markGuest, rememberReturnTo, startAuthSync, subscribe } from './auth/session';
import { createNavbar, navItemsForSite } from './components/navbar';
import { createAboutPage } from './pages/about';
import { createAccountPage, parseAccountTab } from './pages/account';
import { createAuthPage } from './pages/auth';
import { createBlogPage } from './pages/blog';
import { createBlogPostPage } from './pages/blog-post';
import { createHomePageView } from './pages/home-view';
import { createMaintenancePage } from './pages/maintenance';
import { createMessagePage } from './pages/message';
import { createPhotoPage } from './pages/photo';
import { createPublicProfilePage } from './pages/public-profile';
import { createWorkDetailPage } from './pages/work-detail';
import { createWorksPage } from './pages/works';
import { attachHeroParallax } from './scene/hero-parallax';
import { initSmoothScroll } from './scene/smooth-scroll';
import { forceReducedMotion, whenFontsReady } from './scene/text-support';
import { createRouter, type RouteView } from './router';
import { loadSiteConfig, setSiteConfig, SITE_CONFIG_FULL, type SiteConfig } from './site/config';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Root element "#app" was not found in index.html');
}

/**
 * 窄化后的挂载点。
 *
 * 上面那句 `if (!root) throw` 只对**同一层作用域**有效——`boot()` / `mountSite()`
 * 是函数声明，TS 不会把窄化带进它们的函数体（函数可能在任何时候被调用）。
 * 单独取一份 `HTMLDivElement` 常量，就不用在下游写非空断言。
 */
const appRoot: HTMLDivElement = root;

/**
 * 路由 id：五个导航项 + 三个不在导航栏里的页面（`#login` / `#account/…` / `#u/…`）。
 * 真源在 `app-routes.ts`——别在这里手抄一份。当前模式下哪些路由还开着由
 * `routesForSite()` 决定（`SITE_MODE=display` 时只剩 首页 / 作品 / 关于）。
 */
type Route = AppRoute;

/**
 * 截图 / 预览模式（`?wp=` / `?cta=1` / `?probe=` / `?shot=` / `?rm=1`）。
 *
 * 三个影响：
 *   1. 不查会话：headless 在 `load` 附近抓帧，结果必须是确定的游客态。
 *   2. **不问 `/api/site/config`**，直接按 `full` 装配——基准图不该取决于那一刻
 *      后端有没有跑起来，也不该因为某个环境变量变了就整批失效。
 *   3. 保留 `?route=` / `?shot=` 这些 DEV 探针。
 */
const SHOT_QUERY_KEYS = ['wp', 'cta', 'probe', 'shot', 'rm'] as const;

function isShotMode(): boolean {
  const query = new URLSearchParams(window.location.search);
  return SHOT_QUERY_KEYS.some((key) => query.has(key));
}

/**
 * 站点模式（`full` / `display` / `maintenance`）。
 *
 * **必须在装配之前拿到**：要紧的是它决定「路由表里有哪些页」和「导航栏画几项」，
 * 而不是拿到之后再拆——先画出来再删会让滑动胶囊按旧节点量一次，开场就错位。
 *
 * 那一帧的等待是白送的：`.site-header__inner` 在 `is-ready` 之前本来就
 * `visibility: hidden`（rAF + 120ms 兜底），配置请求通常十几毫秒就回来了。
 */
async function boot(): Promise<void> {
  const shotMode = isShotMode();
  /*
   * 只有 **DEV 下的**截图模式才跳过配置请求。生产环境一律问后端：`?shot=home` 是
   * 开发用的 URL 钩子，但它同样能在线上被手工拼出来——如果线上也认它，就等于给
   * `SITE_MODE=display` 留了一个「加个 query 就能把博客导航调出来」的后门。
   */
  const site =
    import.meta.env.DEV && shotMode ? setSiteConfig(SITE_CONFIG_FULL) : await loadSiteConfig();

  if (site.mode === 'maintenance') {
    /*
     * 整站关闭：连导航栏和路由器都不建。
     *
     * 为什么不复用路由器去渲染一个「提示页路由」：那样导航栏、Lenis、hero 视差、
     * 三个 canvas 场景全都会跟着初始化，等于把一个完整的站跑起来只为了显示一行字。
     * 备案期间最该省的就是这些「看起来很活跃」的东西。
     */
    appRoot.append(createMaintenancePage());
    return;
  }

  mountSite(site, shotMode);
}

function mountSite(site: SiteConfig, shotMode: boolean): void {
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

  /** 当前模式下合法的路由。表里没有的 id 会被 `matchRoute` 归一成 `home`。 */
  const routes = routesForSite(site);

  /**
   * 视图工厂。
   *
   * 这里刻意用 `Route` 而不是字符串做键——路由表、视图工厂共用同一份 id
   * （`APP_ROUTES`），任何一处删掉一项，TS 都会在这里报出来（穷尽 switch + 返回类型）。
   * 关掉的页不出现在 `routes` 里，所以这些 case 只是「保留能力」，不是「当前可见」。
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
        /*
         * `#blog` 是列表，`#blog/<slug>` 是帖子详情。
         *
         * slug 的形状由服务端判（前端猜一遍只会多出第二套规则），这里只负责分派；
         * 真不存在就由详情页渲染「没有这篇帖子」。
         */
        return param
          ? createBlogPostPage({ slug: param, navigate: router.navigate })
          : createBlogPage();
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
      case 'photo':
        // 原图查看页，`param` 是原图文件名（`#photo/w-0a3a94442b2ed304.png`）。
        return createPhotoPage({ name: param ?? '' });
    }
  };

  const router = createRouter<Route>({
    routes,
    fallback: 'home',
    container: shell,
    createView,
    onChanged: (route, previous, change) => {
      // 登录页 / 账号页不属于任何导航项，传 null 让胶囊收起来（见 `setActive` 的说明）。
      navbar.setActive(isNavRoute(route) ? route : null);
      // 给 CSS / 调试用：`html[data-route="blog"]`。截图脚本也靠它判断当前落在哪一页。
      document.documentElement.dataset.route = route;
      // 详情页再加一层 `html[data-work="<slug>"]`：同一路由下参数不同，只看 data-route 分不出来。
      // ⚠️ 必须限定 `route === 'works'`：`param` 是所有路由共用的第二段，`#blog/<slug>` 一上线
      // 就会把帖子 slug 写进 `data-work`，截图脚本与调试判定会一起失灵。
      if (route === 'works' && change.param) document.documentElement.dataset.work = change.param;
      else delete document.documentElement.dataset.work;
      // 帖子详情同理：`html[data-post="<slug>"]`。
      if (route === 'blog' && change.param) document.documentElement.dataset.post = change.param;
      else delete document.documentElement.dataset.post;
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
   *
   * 项的数量与右上角账号位都由站点模式决定——`display` 下只剩三项、且没有账号位。
   */
  const navbar = createNavbar({
    items: navItemsForSite(site),
    showAccount: site.features.account,
    account: site.features.account ? getAuthState() : undefined,
    activeId: isNavRoute(router.current) ? router.current : null,
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
  appRoot.append(shell);

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
   *
   * 账号功能被模式关掉时整段跳过：接口已经 404，还去问一次只会白留一条报错日志。
   */
  if (site.features.account) {
    subscribe((state) => {
      navbar.setAccount(state);
    });
    startAuthSync();
  }

  // 截图 / 预览模式不查会话（见 `isShotMode`）；账号关闭时直接定成游客态。
  if (!site.features.account || shotMode) markGuest();
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
    const devQuery = new URLSearchParams(window.location.search);
    // `?route=<id>`：装配完再走一遍**真实的换页路径**（点标签页走的就是它）。
    // 为什么需要它：headless 只有 `--dump-dom` 一条通道，没有这个参数就只能验「首屏落在哪一页」，
    // 验不了「换页」——而换页恰恰是最容易留下旧视图/漏掉 dispose 的地方。
    //
    // ⚠️ 只接受**当前模式下开着**的路由：`SITE_MODE=display` 时 `?route=blog` 应当什么都不做
    // （不能借 DEV 探针把已关掉的页面调出来，否则这个开关就没法实测了）。
    const devRoute = devQuery.get('route');
    if (devRoute && (routes as readonly string[]).includes(devRoute)) {
      // `?route=works&work=<slug>` 直达作品详情；`?route=blog&post=<slug>` 直达帖子；
      // `?route=login&param=register` 直达注册 tab。
      const devParam = devQuery.get('param') ?? devQuery.get('work') ?? devQuery.get('post');
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
}

/*
 * 启动。
 *
 * `boot()` 在 `isShotMode()` 为真时**完全不 await**（那条分支是同步的），所以截图抓帧的
 * 时机与改造前逐帧一致；只有正常访问才会多等一次 `/api/site/config`。
 * 不写成顶层 `await` 是为了不碰 `build.target`——Vite 在 `modules` 目标下会直接报错。
 */
void boot();
