/**
 * 极小的哈希路由：本站只需要「地址栏 ↔ 当前视图」这一层映射，不需要一个路由库。
 *
 * **为什么是哈希而不是 History API**：产物是纯静态的（`vite build` 只有 index.html 与
 * admin.html），路径式路由要求每台静态服务器都配 rewrite，否则刷新 `/blog` 直接 404；
 * 哈希在任何 host 上刷新、分享、按后退都照常工作，导航栏现成的 `#id` 链接也不用改。
 *
 * **未知 / 空哈希统一归一成 `fallback`**，并用 `replaceState` 改写地址栏：如果写成
 * `location.hash = …`，浏览器会多留一条历史记录，用户按后退会卡在同一个视图上
 * （看起来像「后退坏了」，实际是历史里躺着两条一样的地址）。
 *
 * 视图的挂载 / 卸载也归这里管：`dispose()` 之后再 `remove()`，两件事分开做——
 * 板块自己的 dispose 只清监听与画布，`sections/works.ts` 那样顺带 `root.remove()`
 * 的也有，统一补一次 `remove()` 才能保证「换页面之后 DOM 里不留旧视图」。
 */

/** 一个页面视图。首页是「多个同级板块」，所以 elements 是数组。 */
export interface RouteView {
  /**
   * 视图根节点，按顺序挂进容器。
   *
   * ⚠️ **必须落在容器的直接子元素层级**：截图模式靠
   * `html.is-shot-mode .app-shell > *` / `html.is-cta-shot .app-shell > *` 隐藏同级板块
   * （见 `sections/works.ts` 的 `installShotStyles`），中间插一层 wrapper 就会让
   * `?wp=` / `?cta=1` 的基准图失效。
   */
  elements: HTMLElement[];
  /**
   * 节点进了文档之后调用。
   *
   * 需要量 `getBoundingClientRect()` 的东西（枫叶画布的碰撞面、需要真实布局的测量）
   * 都得放在这里——在 `createView()` 里量只会拿到全 0。
   */
  mounted?(): void;
  dispose(): void;
}

/**
 * 一次路由匹配的结果。
 *
 * 引入它是因为地址栏开始承载**第二段**了（`#works/<slug>`，作品详情页）。但「路由 id」
 * 始终只有一段、且必须等于导航项名——导航高亮、`html[data-route]`、截图判断都靠它，
 * 把 id 变成 `works/foo` 会把这些全部打断。所以参数单独放在 `param` 里，
 * 视图工厂按需取用。
 */
export interface RouteMatch<T extends string> {
  readonly id: T;
  /** `#works/<slug>` 的 slug；其余路由恒为 null。 */
  readonly param: string | null;
  /** 规范哈希：`#works` / `#works/foo`（参数已编码）。 */
  readonly hash: string;
}

/** 换页时交给 `onChanged` 的附加信息（只有 `#id/param` 相关字段会变）。 */
export interface RouterChange {
  readonly param: string | null;
  readonly previousParam: string | null;
  readonly hash: string;
}

export interface RouterOptions<T extends string> {
  /** 全部合法路由 id（与导航项同名）。 */
  routes: readonly T[];
  /** 空哈希、未知哈希、以及 `dispose()` 的落点。 */
  fallback: T;
  /** 视图挂载点（本站是 `.app-shell`；导航栏先于视图挂进去，所以永远排在前面）。 */
  container: HTMLElement;
  /** 第二个参数只有 `#id/param` 才有值；旧的一元工厂仍然可以直接赋值。 */
  createView: (route: T, param: string | null) => RouteView;
  /**
   * 视图换好之后回调。滚动复位、导航高亮都挂这里。
   *
   * `previous` 在**首次挂载**时是 `null`——首屏不该被强行拉回页顶（浏览器可能刚恢复
   * 了刷新前的位置），只有真正「换页」时才需要复位。
   */
  onChanged?: (route: T, previous: T | null, change: RouterChange) => void;
}

export interface RouterHandle<T extends string> {
  /** 当前挂载中的路由。 */
  readonly current: T;
  /** 当前路由参数（`#works/<slug>` 的 slug）。 */
  readonly param: string | null;
  /** 挂载首个视图并开始监听。必须在 `main.ts` 的 DEV 探针之前同步调用。 */
  start(): void;
  /**
   * 走地址栏（会留下历史记录，所以后退键能用）。
   *
   * `navigate('works')` = 回作品列表；`navigate('works', slug)` = 进详情。
   * 同路由同参数时只归一化哈希，不重建视图。
   */
  navigate(route: T, param?: string | null): void;
  dispose(): void;
}

const PARAM_MAX = 80;
/** 控制字符：地址栏里出现它们基本意味着手工拼错的链接，直接当无参数处理。 */
const PARAM_BAD = /[\u0000-\u001f\u007f]/;

/** 解码一段地址栏文本；坏编码（`#%`）按空串处理，不让整页因为一个链接崩掉。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/** 校验第二段。只做「能不能当参数用」，不校验业务合法性（slug 对不对由 API 决定）。 */
function readParam(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = safeDecode(raw).trim();
  if (!value || value.length > PARAM_MAX) return null;
  if (value === '.' || value === '..') return null;
  if (value.includes('/') || PARAM_BAD.test(value)) return null;
  return value;
}

/**
 * 从地址栏解析「路由 id + 第二段」。
 *
 * 只匹配第一段：`#works/foo/bar` 的多余段直接丢弃（没有合法的三段路由）。
 * 第二段不做字符集收敛——`#works/FOO` 应当由详情页显示「没找到」，
 * 而不是被路由悄悄改写成列表（那会让人以为链接失效）。
 *
 * 兼容既有写法：`#works` / `#/works` / `#works?x=1` 都算 `works`。
 */
export function matchRoute<T extends string>(routes: readonly T[], fallback: T): RouteMatch<T> {
  const path = window.location.hash.replace(/^#/, '').split('?')[0].trim();
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const head = safeDecode(segments[0] ?? '').replace(/^\/+/, '').trim();
  const matched = routes.find((route) => route === head);
  const id = matched ?? fallback;
  // 只有第一段真的命中路由时，第二段才有意义（`#nope/foo` 归一成 fallback，无参数）。
  const param = matched ? readParam(segments[1]) : null;
  return { id, param, hash: param ? `#${id}/${encodeURIComponent(param)}` : `#${id}` };
}

/** 从地址栏读路由 id：`#works` / `#/works` / `#works?x=1` / `#works/foo` 都算 `works`。 */
export function readRoute<T extends string>(routes: readonly T[], fallback: T): T {
  return matchRoute(routes, fallback).id;
}

export function createRouter<T extends string>(options: RouterOptions<T>): RouterHandle<T> {
  const { routes, fallback, container, createView, onChanged } = options;

  let currentId: T = fallback;
  let currentParam: string | null = null;
  let view: RouteView | null = null;
  let started = false;

  const unmount = (): void => {
    if (!view) return;
    view.dispose();
    for (const element of view.elements) element.remove();
    view = null;
  };

  const swap = (match: RouteMatch<T>, previous: T | null, previousParam: string | null): void => {
    unmount();
    currentId = match.id;
    currentParam = match.param;
    const next = createView(match.id, match.param);
    view = next;
    for (const element of next.elements) container.append(element);
    next.mounted?.();
    onChanged?.(match.id, previous, {
      param: match.param,
      previousParam,
      hash: match.hash,
    });
  };

  /** 地址栏补成规范形式（`#home` / `#works/foo`），且不留历史记录。 */
  const normalizeHash = (match: RouteMatch<T>): void => {
    if (window.location.hash === match.hash) return;
    window.history.replaceState(null, '', match.hash);
  };

  const onHashChange = (): void => {
    const match = matchRoute(routes, fallback);
    /*
     * ★ 必须比 `(id, param)` 二元组。
     *
     * 只比 id 的话 `#works/foo → #works/bar` 会被当成「同一页」直接 return，详情页
     * 永远停在第一条；只比 hash 又会让 `#works/` 这种写法反复重建视图。
     */
    if (match.id === currentId && match.param === currentParam) {
      normalizeHash(match);
      return;
    }
    swap(match, currentId, currentParam);
    normalizeHash(match);
  };

  return {
    get current() {
      return currentId;
    },
    get param() {
      return currentParam;
    },
    start() {
      if (started) return;
      started = true;
      const match = matchRoute(routes, fallback);
      swap(match, null, null);
      normalizeHash(match);
      window.addEventListener('hashchange', onHashChange);
    },
    navigate(route, param = null) {
      const next = param === null || param === '' ? null : param;
      if (route === currentId && next === currentParam) {
        normalizeHash({
          id: route,
          param: next,
          hash: next ? `#${route}/${encodeURIComponent(next)}` : `#${route}`,
        });
        return;
      }
      // 只改地址栏，真正的切换统一由 `hashchange` 走一遍——免得「点击」与
      // 「后退」两条路径各写一套挂载逻辑，早晚会分叉。
      window.location.hash = next ? `#${route}/${encodeURIComponent(next)}` : `#${route}`;
    },
    dispose() {
      window.removeEventListener('hashchange', onHashChange);
      started = false;
      unmount();
    },
  };
}
