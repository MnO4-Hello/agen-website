/**
 * 按当前站点模式拦截接口。
 *
 * 为什么拦在 `onRequest` 而不是每个路由里各判一次：路由有十几个文件、几十条路径，
 * 任何一处漏判就等于那道门没关；而且新加路由的人不会记得来加判断。钩子装在
 * `app.register(路由)` **之前**，Fastify 的钩子只对之后注册的路由生效——所以
 * `app.ts` 里的顺序是硬约束（和 `installAdminGuard` 同一条纪律）。
 *
 * **关掉的功能一律返回 404，不是 403。** 403 的语义是「这里有个东西，你没权限」，
 * 等于向审核员承认「站点本来有社区，只是被关了」；404 才是「这个地址不存在」。
 * body 也刻意复刻 Fastify 默认 404 的形状，让人分不出是拦截还是真没这个路由。
 *
 * ⚠️ 这个钩子**永远安装**（不像早先那样在 `full` 时直接不装）。因为模式能在后台
 * 运行时切换，装不装必须与「启动时是什么模式」脱钩。代价是每个请求多一次函数调用 +
 * 一次字符串比较，相对于 Fastify 的路由匹配与日志序列化完全在噪声里，不必优化。
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

/**
 * 管理接口永远不被站点模式拦。
 *
 * 这是**唯一的自锁出口**：`maintenance` 下其余接口全 503，如果后台也一起关掉，
 * 站长就只能上服务器改文件才能把站救回来。
 *
 * 安全性上没有增量暴露：`admin/guard.ts` 的 `OPEN_ROUTES` 只有 session / login / logout
 * 三个本来就公开的入口，其余全部要求有效 cookie + 每次回表校验角色；`/admin.html`
 * 是静态文件，根本不经过这个钩子。
 */
function isAdminPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api/admin' || path.startsWith('/api/admin/');
}

export function installSiteMode(app: FastifyInstance, getConfig: () => SiteConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    /*
     * CORS 预检不带 cookie，也永远不该被 503。`admin/guard.ts` 里有同一行处理；
     * 漏掉它时跨域部署会表现为一个难懂的 CORS 报错，而不是能看懂的 503。
     */
    if (request.method === 'OPTIONS') return;

    // 绝大多数时间都是 full，先把这条路走掉，后面的前缀匹配都不用跑。
    const config = getConfig();
    if (config.mode === 'full') return;

    const url = request.url;

    // 拿开关的接口自己必须永远活着，否则前端永远只能回退到最严格的那一档。
    if (isAlwaysOpen(url) || isAdminPath(url)) return;

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
