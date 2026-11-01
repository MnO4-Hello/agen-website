/**
 * `GET /api/site/config` —— 前端启动时唯一的功能开关来源。
 *
 * 为什么不做成构建期变量（`VITE_*`）：那要求「改开关 → 重新 build → 重新上传 dist」，
 * 而备案过审这个动作恰恰是**想立刻生效**的。放在后端环境变量里，改 `.env` + 重启进程
 * （`pm2 restart`）就够了，前端静态产物一个字都不用动。
 *
 * 代价是首屏多一次请求（同源、几十字节）。`main.ts` 里那次 `await` 是刻意接受的：
 * 顶栏在 `is-ready` 之前本来就 `visibility: hidden`，这点延迟看不见。
 */

import type { FastifyInstance } from 'fastify';

import type { SiteConfig } from '../site/mode.js';

export function siteRoutes(config: SiteConfig) {
  return async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
    app.get('/site/config', async (_request, reply) => {
      // **必须 no-store**：这份响应缓存在浏览器或 CDN 上，改了模式也不会生效，
      // 而且会出现「导航已经没了、接口还开着」这种最难查的半开状态。
      reply.header('cache-control', 'no-store');
      return config;
    });
  };
}
