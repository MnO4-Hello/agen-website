/**
 * 站点运行模式：**一套代码、两种形态**。
 *
 * 起因是 ICP 备案。以个人（自然人）名义备案时，站内不能有「用户发帖 / 回复 / 评论 /
 * 留言」这类交互式栏目——管局在初审与后续核查里都会点进来实际看。所以同一个仓库既要能
 * 跑完整社区，又要能一键切成「纯展示站」去过审。
 *
 * 三个模式：
 *
 *   · `full`        —— 全部功能。开发、以及不备案的部署（境外 / 仅 IP 访问）用它。
 *   · `display`     —— 只剩 首页 / 作品 / 关于。博客、留言板、注册登录、公开主页全部下线，
 *                      前端不渲染入口，后端对相应接口直接返回 404（不是 403——403 等于
 *                      告诉审核员「这里本来有个功能，只是被关了」）。
 *   · `maintenance` —— 整站关闭，只剩一个「备案中」提示。备案期间最保险的形态。
 *
 * ⚠️ **开关只认后端**。前端启动时问 `/api/site/config` 拿这一份，前端那份配置是**派生**的，
 * 不存在第二个真源——否则迟早出现「导航里有博客、后端却已经关了」的半开状态。
 */

/** 站点的运行模式。 */
export type SiteMode = 'full' | 'display' | 'maintenance';

/**
 * 可以被模式关掉的功能。
 *
 * 刻意**不包含** `works` 与 `about`：作品展示与个人介绍在任何模式下都留着，
 * 那是这个站「主体是什么」的答案，也是备案时填报的网站用途。
 */
export const SITE_FEATURES = ['blog', 'message', 'account', 'profiles'] as const;

export type SiteFeature = (typeof SITE_FEATURES)[number];

export interface SiteConfig {
  readonly mode: SiteMode;
  /** 某一项功能当前是否可用。`works` / `about` 恒为可用，不在这里出现。 */
  readonly features: Readonly<Record<SiteFeature, boolean>>;
}

/**
 * 每个功能对应的接口前缀（都不带 `/api`，拼在下面 `matchFeature` 里）。
 *
 * ⚠️ `/api/users/:username` 是公开个人主页（`routes/profiles.ts`），**不是** `/api/profiles`；
 * 而 `/api/account/media/:file` 虽然也在那个文件里，语义上属于账号，所以挂在 `account` 下。
 * 两处都按「实际注册的路径」写，别按文件名猜。
 */
export const FEATURE_URL_PREFIXES: Readonly<Record<SiteFeature, readonly string[]>> = {
  blog: ['/api/blog'],
  message: ['/api/messages'],
  account: ['/api/auth', '/api/account'],
  profiles: ['/api/users'],
};

/**
 * 不管什么模式都必须放行的接口。
 *
 * `site/config` 是前端拿开关的入口（关掉它前端就永远回退到最严格模式，等于把自己锁死）；
 * `health` 给探活 / 负载均衡用；`hello` 是脚手架自带的连通性探测。
 */
const ALWAYS_OPEN = new Set(['/api/site/config', '/api/health', '/api/hello']);

/**
 * 把一个模式展开成具体的功能表。
 *
 * `display` 下一个功能都不留（作品与关于不在 `SITE_FEATURES` 里，天然不受影响）；
 * `profiles` 还额外依赖 `account`：公开主页的数据全部来自账号，账号关了它不可能还开着。
 * 这条依赖写死在展开逻辑里，免得以后改表时漏掉。
 */
export function resolveSiteConfig(mode: SiteMode): SiteConfig {
  const enabled = mode === 'full';
  const features = {} as Record<SiteFeature, boolean>;
  for (const feature of SITE_FEATURES) features[feature] = enabled;
  // 兜底依赖：账号不可用时，公开主页一并关闭。
  if (!features.account) features.profiles = false;
  return { mode, features };
}

/**
 * 读 `SITE_MODE`。
 *
 * **认不出来的值一律按 `display` 处理**（fail-closed）：拼错一个字母就把整个社区暴露出去，
 * 正是这个开关最不该犯的错。默认值（没配）是 `full`，因为本地开发和境外部署都走这条路，
 * 而真要上线备案的人一定会去翻 `.env.example`。
 */
export function parseSiteMode(raw: string | undefined): SiteMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'full';
  if (value === 'full' || value === 'display' || value === 'maintenance') return value;
  return 'display';
}

/**
 * 这个请求路径是否落在某个功能的接口前缀下。
 *
 * 用「等于」或「前缀 + `/`」而不是裸 `startsWith`：后者会把 `/api/blogger`
 * 这种无关路径一起吞掉。
 */
export function matchFeature(url: string): SiteFeature | null {
  const path = url.split('?')[0] ?? '';
  for (const feature of SITE_FEATURES) {
    for (const prefix of FEATURE_URL_PREFIXES[feature]) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return feature;
    }
  }
  return null;
}

export function isAlwaysOpen(url: string): boolean {
  return ALWAYS_OPEN.has(url.split('?')[0] ?? '');
}
