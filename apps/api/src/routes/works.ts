/**
 * 公开的作品接口（不需要登录）。
 *
 *   GET /api/works              —— 已发布作品的摘要列表（首页作品墙与作品页都用它）
 *   GET /api/works/:slug        —— 单个作品详情（含 README / 自定义 HTML）
 *   GET /api/works/media/:file  —— 作品图片的直链
 *
 * 三个都刻意 `no-store`／走内容哈希缓存：
 *   · JSON 不缓存——后台一按「发布」，前台刷新就该看到，个人站不在乎这点 CDN 命中率；
 *   · 图片**永久**缓存——文件名是内容哈希，换图必然换 URL。
 *
 * ⚠️ **没有**「原样吐出开发者 HTML」的接口。那会在本站源上执行任意脚本，
 * 等于把 iframe 沙箱整个绕过。开发者页面只通过详情页的 `srcdoc` 渲染。
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  findPublished,
  isMediaName,
  listPublished,
  mediaMime,
  mediaPaths,
} from '../works/store.js';
import { WorkError, isSlug } from '../works/validate.js';

/**
 * 业务错误统一转成 `{ error, message }`。
 *
 * 非预期异常也在这里落成 500，而不是往外抛：Fastify 默认的 500 页面是
 * `{"statusCode":500,"error":"Internal Server Error","message":"..."}`，前端那套
 * 「读 message 显示一句人话」的逻辑认不出它。
 */
function fail(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkError) {
    return reply.code(error.statusCode).send({ error: 'work_error', message: error.message });
  }
  app.log.error(error);
  return reply
    .code(500)
    .send({ error: 'work_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

export async function workRoutes(app: FastifyInstance): Promise<void> {
  app.get('/works', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return reply.send({ works: await listPublished() });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/works/:slug', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const raw = (request.params as { slug?: string }).slug ?? '';
    const slug = raw.toLowerCase();

    // 形状不对就不查库：`/api/works/..%2f..%2fworks.json` 这类探测在这里就被挡掉。
    if (!isSlug(slug)) {
      return reply.code(404).send({ error: 'not_found', message: '没有找到这个作品。' });
    }

    try {
      const work = await findPublished(slug);
      if (!work) {
        return reply.code(404).send({ error: 'not_found', message: '没有找到这个作品。' });
      }
      return reply.send({ work });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/works/media/:file', async (request, reply) => {
    const name = (request.params as { file?: string }).file ?? '';

    // ① 只认服务端生成的命名：这一步同时挡掉了 `..`、反斜杠、`%2f` 解码后的斜杠。
    if (!isMediaName(name)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // ② realpath 复核：万一有人往 media 目录里塞了软链接，也出不去。
    const root = await mediaPaths.realDir();
    const real = await realpath(mediaPaths.file(name)).catch(() => null);
    if (!real || !real.startsWith(`${root}${path.sep}`)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) {
      return reply.code(404).send({ error: 'not_found' });
    }

    reply.header('content-type', mediaMime(name));
    reply.header('content-length', String(info.size));
    // 内容哈希命名 → 内容变了 URL 就变了，可以永久缓存。
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    // 就算哪天误传了一张能被当文档打开的图，也不许它跑脚本。
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(real));
  });
}
