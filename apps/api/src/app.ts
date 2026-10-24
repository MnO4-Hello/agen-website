import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import { adminRoutes } from './routes/admin.js';
import { adminConsoleRoutes } from './routes/admin-console.js';
import { adminFileRoutes } from './routes/admin-files.js';
import { adminWorkRoutes } from './routes/admin-works.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { helloRoutes } from './routes/hello.js';
import { healthRoutes } from './routes/health.js';
import { profileRoutes } from './routes/profiles.js';
import { workRoutes } from './routes/works.js';

/**
 * Builds the Fastify instance without starting it, so the same app can be
 * reused by the server entry point and by integration tests.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // The Vite dev proxy keeps requests same-origin, but CORS keeps the API
  // usable when the frontend is served from a different host.
  await app.register(cors, { origin: true });

  await app.register(helloRoutes, { prefix: '/api' });
  await app.register(healthRoutes, { prefix: '/api' });
  // 隐藏管理员入口 `/admin.html` 的登录接口（见 routes/admin.ts 顶部的说明）。
  await app.register(adminRoutes, { prefix: '/api' });
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

  return app;
}
