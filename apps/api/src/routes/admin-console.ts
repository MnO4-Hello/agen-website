/**
 * 管理后台「控制台」接口：把后端进程的实时输出送到浏览器。
 *
 * 三条路由：
 *   GET  /api/admin/console/logs    —— 历史快照（首屏 + SSE 重连补断档）
 *   GET  /api/admin/console/stream  —— SSE 实时推送（日志 + 每 2 秒一份进程状态）
 *   POST /api/admin/console/clear   —— 清空服务端环形缓冲（前端「清空」按钮）
 *
 * 为什么用 SSE 而不是 WebSocket：日志是**单向**的，SSE 走普通 HTTP、自动重连、
 * 浏览器端就一个 `EventSource`，比为了推日志引一个 ws 依赖划算得多。
 *
 * ⚠️ SSE 这里用了 `reply.hijack()`：一旦 hijack，Fastify 就不再管这个响应，
 * 头、心跳、关闭全部由我们自己写。所以每一步都要先检查 `writableEnded`。
 */

import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

import { requireAdmin } from '../admin/session.js';
import { clearLogs, recentLogs, serverStats, subscribeLogs } from '../admin/log-buffer.js';

/** 一次快照最多给多少条（首屏够长就够，翻更早的没意义——缓冲也只有 1000）。 */
const MAX_SNAPSHOT = 500;

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function writeEvent(raw: ServerResponse, event: string, data: unknown): void {
  if (raw.writableEnded || raw.destroyed) return;
  try {
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 客户端已经走了：交给 request 的 close 回调收尾，这里静默即可。
  }
}

export async function adminConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/console/logs', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const query = request.query as Record<string, unknown>;
    const limit = readNumber(query.limit, 200, 1, MAX_SNAPSHOT);
    const after = readNumber(query.after, 0, 0, Number.MAX_SAFE_INTEGER);

    return reply.send({
      logs: recentLogs(limit, after),
      stats: serverStats(),
    });
  });

  app.post('/admin/console/clear', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    clearLogs();
    return reply.send({ ok: true, stats: serverStats() });
  });

  app.get('/admin/console/stream', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const query = request.query as Record<string, unknown>;
    const after = readNumber(query.after, 0, 0, Number.MAX_SAFE_INTEGER);

    // 从这里开始，响应完全归我们管。
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // nginx 之类的反代默认会缓冲整段响应，SSE 就变成「一次性到达」了。
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');
    raw.write(': connected\n\n');

    // 注册订阅在前、补历史在后：两者之间不会有空隙（重复的由前端按 id 去重）。
    const unsubscribe = subscribeLogs((entry) => writeEvent(raw, 'log', entry));

    for (const entry of recentLogs(MAX_SNAPSHOT, after)) {
      writeEvent(raw, 'log', entry);
    }
    writeEvent(raw, 'stats', serverStats());

    const statsTimer = setInterval(() => writeEvent(raw, 'stats', serverStats()), 2000);
    // 注释行心跳：长时间没有日志时，中间的代理才不会把连接当成空闲掐掉。
    const pingTimer = setInterval(() => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(': ping\n\n');
    }, 15000);

    const cleanup = (): void => {
      unsubscribe();
      clearInterval(statsTimer);
      clearInterval(pingTimer);
      if (!raw.writableEnded) raw.end();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
