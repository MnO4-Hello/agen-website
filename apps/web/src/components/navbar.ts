import { effectiveScrollY } from '../scroll-lock';
import type { AuthState } from '../auth/session';
import type { SiteConfig, SiteFeature } from '../site/config';
import { createAccountEntry } from './account-entry';

interface NavItem {
  id: string;
  label: string;
}

const NAV_ITEMS = [
  { id: 'home', label: '主页' },
  { id: 'works', label: '作品' },
  { id: 'blog', label: '博客' },
  { id: 'message', label: '留言' },
  { id: 'about', label: '关于我' },
] as const satisfies readonly NavItem[];

/** 单条导航项的类型（字面量联合，不是宽泛的 `NavItem`）。 */
export type NavItemView = (typeof NAV_ITEMS)[number];

/** 导航项 id，同时也是路由 id（`#home` / `#works` / …）。 */
export type NavItemId = (typeof NAV_ITEMS)[number]['id'];

/**
 * 导航项 → 它依赖的站点功能。
 *
 * 只有这两项会被模式关掉；`home` / `works` / `about` 不在表里，恒显示。
 * **为什么不在 `navbar` 里 import `app-routes`**：那边已经 import 了本文件的
 * `NAV_ROUTES`，再反向依赖就成环了（ESM 能跑，但初始化的先后顺序会变成隐式约定，
 * 改一行就可能变成 `undefined`）。规则这么短，就地写一份更安全。
 */
const NAV_ITEM_FEATURE: Partial<Record<NavItemId, SiteFeature>> = {
  blog: 'blog',
  message: 'message',
};

/** 当前模式下应当出现在导航栏里的项（顺序不变）。 */
export function navItemsForSite(config: SiteConfig): readonly NavItemView[] {
  return NAV_ITEMS.filter((item) => {
    const feature = NAV_ITEM_FEATURE[item.id];
    return feature === undefined || config.features[feature];
  });
}

/**
 * 全部导航项 id，顺序与导航栏一致。
 *
 * `main.ts` 的路由表直接用它，别再手抄一份——两处各写一份，早晚会出现「导航里有、
 * 路由表里没有」的哑项（点了没反应，且没有任何报错）。
 */
export const NAV_ROUTES: readonly NavItemId[] = NAV_ITEMS.map((item) => item.id);

export interface NavbarOptions {
  /** Item highlighted on first render. Defaults to the homepage. */
  activeId?: NavItemId | null;
  /** 点击某一项时回调（路由接管跳转；同页时由调用方决定要不要回到页顶）。 */
  onSelect?: (id: NavItemId) => void;
  /** 首帧的账号状态；之后由 `setAccount()` 更新。 */
  account?: AuthState;
  /** 点击「登录 / 注册」时回调——此刻地址栏还是原页面，登录完要能跳回来。 */
  onRememberReturnTo?: (hash: string) => void;
  /** 点「退出登录」时回调（真正的登出与跳转由 `main.ts` 编排）。 */
  onLogout?: () => void;
  /**
   * 要渲染的导航项，默认全部。
   *
   * `main.ts` 会按站点模式过滤后传进来（`navItemsForSite()`）。**过滤必须发生在
   * 渲染之前**，不能先画出来再删——那样胶囊的 `offsetLeft` 会按旧节点量一次，
   * 动画开场就错位。
   */
  items?: readonly NavItemView[];
  /**
   * 是否渲染右上角的账号位，默认渲染。
   *
   * `display` 模式下注册 / 登录已整体关闭，入口一起收掉（否则点进去是空白页）。
   * 关掉时 `data-auth` 写 `off`，CSS 用那条规则把 `--account-reserve` 归零，
   * 导航才会重新贴住右边缘。
   */
  showAccount?: boolean;
}

export interface NavbarHandle {
  element: HTMLElement;
  /**
   * 从外部改当前项（路由变化、浏览器后退都走这里）。
   *
   * 高亮与滑动胶囊全靠它同步：导航栏自己只知道「谁被点过」，不知道地址栏变成了什么，
   * 少了这个方法，按后退键以后胶囊会停在上一次点击的位置。
   *
   * `null` 表示「当前这一页不属于任何导航项」（`#login` / `#account/…`）：
   * 高亮全部摘掉、胶囊收成零宽。**光把 activeId 置空是不够的**——胶囊的位置是
   * 上一次 `moveIndicator` 写死的行内样式，它会留在原地。
   */
  setActive(id: NavItemId | null): void;
  /** 登录态变化：重画右上角的「登录 / 注册」或头像菜单。 */
  setAccount(state: AuthState): void;
  dispose(): void;
}

/**
 * Top navigation bar: the brand wordmark on the left, section links on the
 * right. A single pill slides between links (also following hover/focus) so
 * the active state stays readable at a glance.
 */
export function createNavbar(options: NavbarOptions = {}): NavbarHandle {
  const items = options.items ?? NAV_ITEMS;
  const showAccount = options.showAccount ?? true;

  const header = document.createElement('header');
  header.className = 'site-header';

  const inner = document.createElement('div');
  inner.className = 'site-header__inner';

  const brandWrap = document.createElement('div');
  brandWrap.className = 'site-header__brand';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '#home';
  brand.textContent = '阿根';
  brand.setAttribute('aria-label', '阿根，返回主页');
  brand.addEventListener('click', (event) => {
    // 交给路由：已经在主页时由 `main.ts` 的 onSelect 落成「回到页顶」。
    event.preventDefault();
    activeId = 'home';
    previewId = null;
    syncActive();
    options.onSelect?.('home');
  });
  brandWrap.append(brand);

  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.setAttribute('aria-label', '主导航');

  const navWrap = document.createElement('div');
  navWrap.className = 'site-header__nav';
  navWrap.append(nav);

  /*
   * 账号位**不在** flex 流里，而是绝对定位贴在 `__inner` 的右边缘。
   *
   * 原因：`.site-header__nav` 缩放时用的是 `transform-origin: top right`，它的右边缘
   * 必须一直在内容右缘；一旦右侧多一个参与布局的兄弟节点，nav 的右边缘就会被挤进来，
   * 滚动收缩时整个胶囊会停在离角落一个账号位宽的地方。
   * 所以改成「nav 用一个可变的 `margin-right` 预留出账号位的宽度」（见 styles.css），
   * 而账号位本身脱离布局——两边互不影响，`.nav` 内部的 `offsetLeft` 更是完全没变。
   */
  const account = showAccount
    ? createAccountEntry({
        header,
        onRememberReturnTo: (hash) => options.onRememberReturnTo?.(hash),
        onLogout: () => options.onLogout?.(),
      })
    : null;
  // `off` 是新增的一档：账号位根本没渲染时用它，CSS 据此把预留宽度归零。
  header.dataset.auth = account ? (options.account?.status ?? 'unknown') : 'off';
  account?.setState(options.account ?? { status: 'unknown' });

  const indicator = document.createElement('span');
  indicator.className = 'nav__indicator';
  indicator.setAttribute('aria-hidden', 'true');
  nav.append(indicator);

  const links = new Map<NavItemId, HTMLAnchorElement>();
  let activeId: NavItemId | null = options.activeId ?? 'home';
  let previewId: NavItemId | null = null;

  const currentTarget = (): HTMLElement | undefined => {
    const id = previewId ?? activeId;
    return id ? links.get(id) : undefined;
  };

  // `animate: false` is used for layout jumps (first paint, resize) so the
  // pill reappears in place instead of flying across the bar.
  //
  // Offset metrics are deliberate: the nav wrapper is scaled on scroll, and
  // `offsetLeft` / `offsetWidth` are layout values that ignore that transform.
  // Both the pill and the links live inside the same scaled subtree, so they
  // end up scaled by the same factor and stay aligned. Using
  // `getBoundingClientRect` here would apply the scale twice and drift.
  const moveIndicator = (target: HTMLElement, animate: boolean): void => {
    if (!animate) indicator.style.transition = 'none';
    indicator.style.width = `${target.offsetWidth}px`;
    indicator.style.transform = `translateX(${target.offsetLeft}px)`;
    if (!animate) {
      void indicator.offsetWidth;
      indicator.style.transition = '';
    }
  };

  const syncActive = (): void => {
    links.forEach((link, id) => {
      const isActive = id === activeId;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    const target = currentTarget();
    if (target) {
      indicator.style.removeProperty('opacity');
      moveIndicator(target, true);
      return;
    }
    // 当前页不属于任何导航项（`#login` / `#account/…`）：胶囊收成零宽。
    // 不清行内样式它就会停在上一次点击的位置，看起来像「登录页高亮了留言」。
    indicator.style.opacity = '0';
    indicator.style.width = '0px';
    indicator.style.transform = 'translateX(0px)';
  };

  // Resize is a layout jump: snap the pill instead of animating it across the bar.
  const onResize = (): void => {
    const target = currentTarget();
    if (target) moveIndicator(target, false);
  };

  for (const item of items) {
    const link = document.createElement('a');
    link.className = 'nav__link';
    link.href = `#${item.id}`;
    link.textContent = item.label;

    link.addEventListener('pointerenter', () => {
      previewId = item.id;
      moveIndicator(link, true);
    });

    link.addEventListener('focus', () => {
      previewId = item.id;
      moveIndicator(link, true);
    });

    link.addEventListener('blur', () => {
      previewId = null;
      syncActive();
    });

    link.addEventListener('click', (event) => {
      // 跳转交给路由（`options.onSelect`）。这里先就地更新高亮，是为了点击后**立刻**
      // 有反馈——不必等 hashchange 绕一圈回来再让胶囊追上指针。
      event.preventDefault();
      previewId = null;
      activeId = item.id;
      syncActive();
      options.onSelect?.(item.id);
    });

    links.set(item.id, link);
    nav.append(link);
  }

  nav.addEventListener('pointerleave', () => {
    previewId = null;
    syncActive();
  });

  window.addEventListener('resize', onResize);

  // The hairline/shadow only appear once the page has actually scrolled. Read the
  // effective scroll position so the pinned identity playback (which freezes
  // `window.scrollY`) does not make the bar flicker back to its top-of-page look.
  const syncScrolled = (): void => {
    header.classList.toggle('is-scrolled', effectiveScrollY() > 4);
  };
  window.addEventListener('scroll', syncScrolled, { passive: true });
  syncScrolled();

  inner.append(brandWrap, navWrap);
  if (account) inner.append(account.element);
  header.append(inner);

  // Reveal the header once layout is measurable. `requestAnimationFrame` is the
  // normal path, but it is suspended while a tab is backgrounded
  // (`document.hidden`), so a timer fallback guarantees the header still
  // appears instead of staying hidden forever.
  const reveal = (): void => {
    if (header.classList.contains('is-ready')) return;
    // Establish the initial active link (and its `aria-current`) before the
    // first measurement, then snap the pill into place without animating.
    syncActive();
    const target = currentTarget();
    if (target) moveIndicator(target, false);
    header.classList.add('is-ready');
  };

  requestAnimationFrame(reveal);
  window.setTimeout(reveal, 120);

  return {
    element: header,
    setActive: (id: NavItemId | null): void => {
      // 胶囊的落点只由导航项自己的 `offsetLeft/offsetWidth` 决定，与页面内容无关，
      // 所以换页后不需要重新测量；这里只需把高亮与胶囊同步过去。
      activeId = id;
      previewId = null;
      syncActive();
    },
    setAccount: (state: AuthState): void => {
      // 账号位没渲染（`display` 模式）时改状态没有意义，直接忽略。
      if (!account) return;
      // `data-auth` 决定 `.site-header__nav` 预留多宽（游客只有两个短链接，占得少）。
      header.dataset.auth = state.status;
      account.setState(state);
    },
    dispose: () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', syncScrolled);
      account?.dispose();
    },
  };
}
