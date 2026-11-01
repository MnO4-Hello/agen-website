/**
 * 按 `SiteConfig` 拦截接口。
 *
 * 为什么拦在 `onRequest` 而不是每个路由里各判一次：路由有十几个文件、几十条路径，
 * 任何一处漏判就等于那道门没关；而且新加路由的人不会记得来加判断。钩子装在
 * `app.register(路由)` **之前**，Fastify 的钩子只对之后注册的路由生效——所以
 * `app.ts` 里的顺序是硬约束（和 `installAdminGuard` 同一条纪律）。
 *
 * **关掉的功能一律返回 404，不是 403。** 403 的语义是「这里有个东西，你没权限」，
 * 等于向审核员承认「站点本来有社区，只是被关了」；404 才是「这个地址不存在」。
 * body 也刻意复刻 Fastify 默认 404 的形状，让人分不出是拦截还是真没这个路由。
 */

import type { FastifyInstance } from 'fastify';

import { isAlwaysOpen, matchFeature, type SiteConfig } from './mode.js';

/** 复刻 Fastify 默认 404 的形状（`Route GET:/x not found`）。 */
function notFoundBody(method: string, url: string): Record<string, unknown> {
  return {
    message: `Route ${method}:${url} not found`,
    error: 'Not Found',
    statusCode: 404,
  };
}

export function installSiteMode(app: FastifyInstance, config: SiteConfig): void {
  /*
   * `full` 下直接不装钩子：这是绝大多数运行时间里的状态，多一个每请求都要走的
   * 字符串比较没有意义。代价是「运行中改模式」不可行——改 `.env` 本来就要求重启。
   */
  if (config.mode === 'full') return;

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;

    // 拿开关的接口自己必须永远活着，否则前端永远只能回退到最严格的那一档。
    if (isAlwaysOpen(url)) return;

    if (config.mode === 'maintenance') {
      // 备案期间整站关闭。Web 服务器层（Nginx）通常已经先挡了一道，这里是第二道：
      // 万一反向代理的配置没同步，接口也不会漏出去。
      return reply
        .code(503)
        .header('cache-control', 'no-store')
        .header('retry-after', '86400')
        .send({
          error: 'maintenance',
          message: '站点正在备案中，暂不对外开放。',
        });
    }

    const feature = matchFeature(url);
    if (feature && !config.features[feature]) {
      return reply.code(404).send(notFoundBody(request.method, url));
    }
  });
}
