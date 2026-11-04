/**
 * 全站路由 id 的唯一真源。
 *
 * 为什么单独一个文件：导航项（`NAV_ROUTES`）既是**导航栏的渲染清单**，也是路由表的一部分，
 * 但站点还有三类「不在导航栏里」的页面：
 *
 *   · `login`   —— 登录 / 注册（`#login`、`#login/register`）
 *   · `account` —— 个人中心 / 我的主页 / 设置（`#account/<tab>`）
 *   · `u`       —— 公开个人主页（`#u/<用户名>`），游客可访问，是唯一「带别人名字」的路由
 *
 * 它们绝不能塞进 `NAV_ROUTES`：那份清单同时驱动导航链接的渲染、`html[data-route]`
 * 的取值、以及截图脚本对页面的判断。
 *
 * ⚠️ 首页各板块与 `#works/<slug>` 的约束不受影响——这里只是把「路由表」从「导航表」
 * 里拆出来一层，`matchRoute()` 的两段解析原样复用。
 */

import { NAV_ROUTES, type NavItemId } from './components/navbar';
import type { SiteConfig } from './site/config';

export type AppRoute = NavItemId | 'login' | 'account' | 'u' | 'photo';

/** 不在导航栏里的路由（新增一个不在导航里的页面，只改这一行）。 */
const EXTRA_ROUTES = ['login', 'account', 'u', 'photo'] as const satisfies readonly AppRoute[];

/** 传给 `createRouter()` 的完整路由表。 */
export const APP_ROUTES: readonly AppRoute[] = [...NAV_ROUTES, ...EXTRA_ROUTES];

const ALL: readonly string[] = APP_ROUTES;

export function isAppRoute(value: string): value is AppRoute {
  return ALL.includes(value);
}

/**
 * 按站点模式判断一条路由是否还开着。
 *
 * 关掉一条路由**不需要在 `main.ts` 里删 case**：`matchRoute()` 只在传入的 `routes`
 * 表里找，表里没有的 id 会被统一归一成 `fallback`（`home`）。所以「关掉博客」的
 * 实际效果是：地址栏敲 `#blog` 也落在首页，导航里也不会有那一项——正是想要的。
 *
 * `works` / `about` 恒为 `true`：它们是备案时填报的「网站用途」本身。
 */
export function isRouteEnabled(route: AppRoute, config: SiteConfig): boolean {
  switch (route) {
    case 'blog':
      return config.features.blog;
    case 'message':
      return config.features.message;
    case 'login':
    case 'account':
      return config.features.account;
    case 'u':
      return config.features.profiles;
    case 'photo':
      /*
       * 原图页恒开。它是「压缩图 → 原图」这条链路的另一半：只要还有任何一张图
       * 能被点开，这一页就必须能打开。跟着某个内容模块一起关掉的话，点图会落到
       * 首页，用户会以为图坏了。
       */
      return true;
    case 'home':
    case 'works':
    case 'about':
      return true;
  }
}

/**
 * 当前模式下可用的路由表，交给 `createRouter()`。
 *
 * `home` 永远留在表里：它是 `fallback`，不在表里的话 `matchRoute` 会返回一个
 * 拿不到视图的 id。这行兜底看着多余，但真删掉就是整站白屏。
 */
export function routesForSite(config: SiteConfig): readonly AppRoute[] {
  const routes = APP_ROUTES.filter((id) => isRouteEnabled(id, config));
  return routes.includes('home') ? routes : ['home', ...routes];
}

/** 是不是「某个导航项」——`#login` / `#account` / `#u/…` 要清掉导航高亮。 */
export function isNavRoute(id: AppRoute): id is NavItemId {
  return (NAV_ROUTES as readonly string[]).includes(id);
}

export interface HashRoute {
  readonly route: AppRoute;
  readonly param: string | null;
}

/**
 * 把 `"#works/foo"` 这类哈希拆成 `{ route, param }`。
 *
 * 只给「登录成功后跳回原处」这类内部用途，校验刻意宽松：认不出来的就回首页，
 * 反正真正的挂载仍由路由自己走一遍 `matchRoute`。
 *
 * `#u/<用户名>` 的第二段会被 `decodeURIComponent` 还原——用户名允许非 ASCII 时
 * （未来放开的话）地址栏里是百分号编码，这里还原一次才不会拿编码后的串去查库。
 */
export function parseHashRoute(hash: string): HashRoute {
  const raw = hash.replace(/^#/, '').split('?')[0] ?? '';
  const segments = raw.split('/').filter((segment) => segment.length > 0);
  const head = (segments[0] ?? '').trim();

  // 认不出来的第一段一律回首页（与 `matchRoute` 的 fallback 行为一致）。
  if (!isAppRoute(head)) return { route: 'home', param: null };

  const param = segments[1];
  if (!param) return { route: head, param: null };

  try {
    return { route: head, param: decodeURIComponent(param) };
  } catch {
    return { route: head, param: null };
  }
}
