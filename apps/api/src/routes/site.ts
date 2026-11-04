/**
 * `GET /api/site/config` —— 前端启动时唯一的功能开关来源。
 *
 * 为什么不做成构建期变量（`VITE_*`）：那要求「改开关 → 重新 build → 重新上传 dist」，
 * 而备案过审这个动作恰恰是**想立刻生效**的。放在后端，现在连重启都不用——
 * 后台点一下，下一次请求就是新的（见 `site/runtime.ts`）。
 *
 * ⚠️ **每次请求都要读 `currentSiteConfig()`**，不能像早先那样在闭包里存一份。
 * 存了就是第二份真源：配置接口说 `display`、博客接口照常 200，这种半开状态最难查。
 *
 * 代价是首屏多一次请求（同源、几十字节）。`main.ts` 里那次 `await` 是刻意接受的：
 * 顶栏在 `is-ready` 之前本来就 `visibility: hidden`，这点延迟看不见。
 */

import type { FastifyInstance } from 'fastify';

import { currentSiteConfig } from '../site/runtime.js';

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/site/config', async (_request, reply) => {
    // **必须 no-store**：这份响应缓存在浏览器或 CDN 上，改了模式也不会生效，
    // 而且会出现「导航已经没了、接口还开着」这种最难查的半开状态。
    reply.header('cache-control', 'no-store');
    return currentSiteConfig();
  });
}
