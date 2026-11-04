/**
 * 前端这一侧的站点模式（`full` / `display` / `maintenance`）。
 *
 * **开关的真源在后端**（运行期是 `apps/api/src/site/runtime.ts` 的内存 holder，
 * 落盘 `apps/api/data/site-mode.json`；环境变量 `SITE_MODE` 只决定还没人从后台切过时的
 * 初始形态），这里只是启动时把它取回来的一份派生副本。类型是手抄的镜像而不是跨包 import：
 * `apps/web` 不该把 `apps/api` 的源码拉进浏览器构建里（后端用 `node:` 前缀与
 * `.js` 后缀的 import，Vite 根本解析不了）。两边约定只有四个字段，抄一份比配一个
 * 共享包便宜得多。
 *
 * **拿不到配置时按 `display` 处理**（fail-closed）。后端挂了 / 接口 404 / 字段不认识，
 * 结果都应该是「站看起来干净」，而不是「社区照常开放」——这个开关存在的唯一理由就是
 * 过审，任何降级都必须往严格那一侧倒。
 */

export type SiteMode = 'full' | 'display' | 'maintenance';

export type SiteFeature = 'blog' | 'message' | 'account' | 'profiles';

export interface SiteConfig {
  readonly mode: SiteMode;
  readonly features: Readonly<Record<SiteFeature, boolean>>;
}

const NO_FEATURES: Record<SiteFeature, boolean> = {
  blog: false,
  message: false,
  account: false,
  profiles: false,
};

/** 全关：取不到配置、或后端说自己是 `display` 时都用它。 */
export const SITE_CONFIG_DISPLAY: SiteConfig = { mode: 'display', features: NO_FEATURES };

/** 全开：本地截图模式用它，保证既有基准图不受后端有没有跑起来影响。 */
export const SITE_CONFIG_FULL: SiteConfig = {
  mode: 'full',
  features: { blog: true, message: true, account: true, profiles: true },
};

let current: SiteConfig = SITE_CONFIG_DISPLAY;

/** 当前生效的配置（`main.ts` 在装配前一定已经 `await loadSiteConfig()`）。 */
export function siteConfig(): SiteConfig {
  return current;
}

/**
 * 落地一份配置：写模块变量 + 在 `html` 上留一个 `data-site-mode`。
 *
 * 那个属性是给 CSS 与调试用的——量页面时一眼就能看出现在是哪一档，
 * 不用去翻网络面板。
 */
export function setSiteConfig(config: SiteConfig): SiteConfig {
  current = config;
  document.documentElement.dataset.siteMode = config.mode;
  return current;
}

/**
 * 校验后端返回的 JSON。
 *
 * `mode` 认不出来就整份作废（回退 `display`），而不是「先信一半」——半个配置比没有
 * 配置更危险：可能出现 `mode: 'display'` 但 `features.blog: true` 这种自相矛盾的组合。
 * 展开时以后端的 `features` 为准，但**只接受布尔值**，缺字段按 `false`。
 */
function normalize(payload: unknown): SiteConfig | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { mode?: unknown; features?: unknown };
  const mode = raw.mode;
  if (mode !== 'full' && mode !== 'display' && mode !== 'maintenance') return null;

  const features = { ...NO_FEATURES };
  if (raw.features && typeof raw.features === 'object') {
    const source = raw.features as Record<string, unknown>;
    for (const key of Object.keys(features) as SiteFeature[]) {
      features[key] = source[key] === true;
    }
  }
  // 与后端同一条依赖：账号不可用时公开主页一并关掉。
  if (!features.account) features.profiles = false;
  return { mode, features };
}

/** 配置请求的超时。后端同源、几十字节，2.5s 还没回来说明它已经不健康了。 */
const CONFIG_TIMEOUT_MS = 2500;

/**
 * 从后端取配置。**永远不抛异常**——任何失败都安静地落到 `display`。
 *
 * 故意用 `no-store`：浏览器缓存一份 `full`，改完模式刷新还是社区，是最难查的那种问题。
 */
export async function loadSiteConfig(): Promise<SiteConfig> {
  try {
    const response = await fetch('/api/site/config', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) return setSiteConfig(SITE_CONFIG_DISPLAY);
    const parsed = normalize(await response.json());
    return setSiteConfig(parsed ?? SITE_CONFIG_DISPLAY);
  } catch {
    return setSiteConfig(SITE_CONFIG_DISPLAY);
  }
}
