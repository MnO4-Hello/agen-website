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

export type AppRoute = NavItemId | 'login' | 'account' | 'u';

/** 不在导航栏里的路由（新增一个不在导航里的页面，只改这一行）。 */
const EXTRA_ROUTES = ['login', 'account', 'u'] as const satisfies readonly AppRoute[];

/** 传给 `createRouter()` 的完整路由表。 */
export const APP_ROUTES: readonly AppRoute[] = [...NAV_ROUTES, ...EXTRA_ROUTES];

const ALL: readonly string[] = APP_ROUTES;

export function isAppRoute(value: string): value is AppRoute {
  return ALL.includes(value);
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
