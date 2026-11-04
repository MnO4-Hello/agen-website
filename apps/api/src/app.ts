import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import { installAdminGuard } from './admin/guard.js';
import { adminAccountRoutes } from './routes/admin-accounts.js';
import { adminRoutes } from './routes/admin.js';
import { adminBlogRoutes } from './routes/admin-blog.js';
import { adminConsoleRoutes } from './routes/admin-console.js';
import { adminFileRoutes } from './routes/admin-files.js';
import { adminMessageRoutes } from './routes/admin-messages.js';
import { adminSettingsRoutes } from './routes/admin-settings.js';
import { adminWorkRoutes } from './routes/admin-works.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { blogRoutes } from './routes/blog.js';
import { helloRoutes } from './routes/hello.js';
import { healthRoutes } from './routes/health.js';
import { messageRoutes } from './routes/messages.js';
import { profileRoutes } from './routes/profiles.js';
import { siteRoutes } from './routes/site.js';
import { workRoutes } from './routes/works.js';
import { installSiteMode } from './site/guard.js';
import { currentSiteConfig, disabledFeatures, initSiteMode } from './site/runtime.js';

/**
 * Builds the Fastify instance without starting it, so the same app can be
 * reused by the server entry point and by integration tests.
 */
export async function buildApp(): Promise<FastifyInstance> {
  /*
   * `trustProxy` 默认关闭：本机 / 局域网直连时开着反而能让客户端伪造 `X-Forwarded-For`，
   * 把限流键换成任意值。但如果部署在 Nginx / Cloudflare 后面又不打开，所有请求的
   * `request.ip` 都会是代理地址——游客限流就退化成「全站共用一个桶」，一个人能把所有
   * 人锁死。所以它是个**环境相关的开关**，由 `TRUST_PROXY=1` 显式打开。
   */
  const trustProxy = process.env.TRUST_PROXY === '1';
  const app = Fastify({ logger: true, trustProxy });

  /*
   * 站点模式：运行期真源是 `site/runtime.ts` 的内存 holder（落盘 `data/site-mode.json`），
   * 后台可以在不停机的情况下切换。`display` / `maintenance` 下博客、留言板、账号相关的
   * 接口会被整体挡掉，只剩展示性内容（见 `site/mode.ts` 顶部）。
   *
   * 钩子必须装在所有 `app.register(路由)` 之前——Fastify 的钩子只对之后注册的路由生效，
   * 装晚了不报错、只是静默失效，这条坑和下面的 `installAdminGuard` 是同一个。
   *
   * 传进去的是 **getter 而不是快照**：模式可变，快照就等于第二份真源。
   * 顺带记一句：顺序若与 `installAdminGuard` 对调，功能仍然正确（钩子会先做一次
   * 账号回表，再被拦），只是 maintenance 下每个后台请求都白查一次库。
   */
  const init = await initSiteMode();
  if (init.error) app.log.error(init.error);
  const site = init.snapshot;
  const off = disabledFeatures(site);
  const summary = `SITE_MODE=${site.mode}（来源：${site.source}${
    site.source === 'env' ? `，环境变量 ${site.envMode}` : ''
  }${site.corrupt ? '，存储文件损坏' : ''}）${
    off.length > 0 ? `：已关闭 ${off.join(' / ')} 的接口` : '：全部功能开放'
  }`;
  // 被关掉是一个需要被看见的状态（尤其是别人接手这台机器时），full 就只当普通信息。
  if (site.mode === 'full') app.log.info(summary);
  else app.log.warn(summary);
  installSiteMode(app, currentSiteConfig);

  // The Vite dev proxy keeps requests same-origin, but CORS keeps the API
  // usable when the frontend is served from a different host.
  await app.register(cors, { origin: true });

  /*
   * 管理接口的统一守卫：回表校验「这个人现在还是不是管理员」+ 站长专属路由。
   *
   * **必须在下面所有 `app.register(路由)` 之前**：Fastify 的钩子只对「之后注册」的
   * 路由生效，放晚了就等于没装（而且不会报错，只会静默失效）。
   */
  installAdminGuard(app);

  await app.register(helloRoutes, { prefix: '/api' });
  await app.register(healthRoutes, { prefix: '/api' });
  // 前端启动时拿功能开关（`GET /api/site/config`）。任何模式下都开放，见 site/guard.ts。
  await app.register(siteRoutes, { prefix: '/api' });
  // 隐藏管理员入口 `/admin.html` 的登录接口（见 routes/admin.ts 顶部的说明）。
  await app.register(adminRoutes, { prefix: '/api' });
  // 管理后台的「设置」：站点形态开关（站长专属，见 routes/admin-settings.ts）。
  await app.register(adminSettingsRoutes, { prefix: '/api' });
  // 站点账号：注册 / 登录 / 登出 / 查会话（见 routes/auth.ts）。
  await app.register(authRoutes, { prefix: '/api' });
  // 个人中心的写接口：资料 / 密码 / 头像封面（全部要登录，见 routes/account.ts）。
  await app.register(accountRoutes, { prefix: '/api' });
  // 公开个人主页 `#u/<用户名>` 与账号媒体直链（见 routes/profiles.ts）。
  await app.register(profileRoutes, { prefix: '/api' });
  // 管理后台的「控制台」：把本进程 stdout/stderr 的输出通过 SSE 实时送给浏览器。
  await app.register(adminConsoleRoutes, { prefix: '/api' });
  // 管理后台的「文件管理」：只允许操作 .env 里白名单列出的目录（默认三处）。
  await app.register(adminFileRoutes, { prefix: '/api' });
  // 作品：公开读（列表 / 详情 / 图片直链）。写操作在下面的 admin-work 里。
  await app.register(workRoutes, { prefix: '/api' });
  // 管理后台的「作品」：增删改查、发布、排序、图片上传（全部要 requireAdmin）。
  await app.register(adminWorkRoutes, { prefix: '/api' });
  // 博客：公开读 + 回复 + 投票（游客回复要过站内人机验证，见 routes/blog.ts）。
  await app.register(blogRoutes, { prefix: '/api' });
  // 管理后台的「内容」：帖子 / 分类 / 回复（全部要 requireAdmin）。
  await app.register(adminBlogRoutes, { prefix: '/api' });
  // 留言板：公开读 + 发留言 / 回复 + 图片（游客要过站内人机验证，见 routes/messages.ts）。
  await app.register(messageRoutes, { prefix: '/api' });
  // 管理后台的「留言」：审核（隐藏/恢复）与站长回复（全部要 requireAdmin）。
  await app.register(adminMessageRoutes, { prefix: '/api' });
  // 管理后台的「账户」与「徽章」：列表/搜索、封禁/禁言、改角色、徽章目录与授予。
  await app.register(adminAccountRoutes, { prefix: '/api' });

  return app;
}
