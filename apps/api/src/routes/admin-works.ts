/**
 * 管理后台的作品接口。每条路由的第一行都是 `requireAdmin()`——**别自己判 cookie**。
 *
 *   GET    /api/admin/works              —— 全部（含草稿）
 *   POST   /api/admin/works              —— 新建
 *   PUT    /api/admin/works/:id          —— 更新（局部；只传一个字段也行）
 *   DELETE /api/admin/works/:id          —— 删除（媒体进回收站，不 rm）
 *   POST   /api/admin/works/:id/publish  —— 发布 / 取消发布
 *   POST   /api/admin/works/reorder      —— 按 id 顺序重排（必须是全量置换）
 *   POST   /api/admin/works/media        —— 上传图片（裸 octet-stream）
 *
 * 两个体积上限分开设：
 *   · JSON 请求 2MB——自定义 HTML 上限 512KB，转义成 JSON 后可能翻倍；
 *   · 图片上传 25MB——与「文件管理」保持一致，别在两处用不同的数字。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireAdmin } from '../admin/session.js';
import {
  createWork,
  listAll,
  removeWork,
  reorderWorks,
  saveMedia,
  setPublished,
  updateWork,
} from '../works/store.js';
import { WorkError } from '../works/validate.js';

const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const MEDIA_BODY_LIMIT = 25 * 1024 * 1024;

function fail(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkError) {
    return reply.code(error.statusCode).send({ error: 'work_error', message: error.message });
  }
  app.log.error(error);
  return reply
    .code(500)
    .send({ error: 'work_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

/** 路由参数 `:id` 是内部 UUID；形状不对就别往下走（也别去读文件）。 */
function readId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  // UUID 的实际格式不重要，只要求「非空且不含路径字符」，避免拼出奇怪的日志行。
  if (!id || id.length > 64 || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new WorkError(404, '没有这个作品。');
  }
  return id;
}

export async function adminWorkRoutes(app: FastifyInstance): Promise<void> {
  /*
   * 图片上传用的是裸二进制流。
   *
   * 必须在本插件里**再注册一次**：`admin-files.ts` 里那个解析器是它自己插件作用域的，
   * 出了那个作用域就看不到（Fastify 的封装规则）。不注册的表现是上传 415。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MEDIA_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/admin/works', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      return reply.send({ works: await listAll() });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/works', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const work = await createWork(request.body);
      return reply.code(201).send({ work });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.put('/admin/works/:id', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      return reply.send({ work: await updateWork(readId((request.params as { id?: string }).id), request.body) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.delete('/admin/works/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const result = await removeWork(readId((request.params as { id?: string }).id));
      return reply.send({ ok: true, trashedTo: result.trashedTo });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/works/:id/publish', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = request.body;
    const published =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).published
        : undefined;
    if (typeof published !== 'boolean') {
      return reply.code(400).send({ error: 'work_error', message: 'published 必须是布尔值。' });
    }
    try {
      const id = readId((request.params as { id?: string }).id);
      return reply.send({ work: await setPublished(id, published) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/works/reorder', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = request.body;
    const ids =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).ids : undefined;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'work_error', message: 'ids 必须是 id 数组。' });
    }
    try {
      return reply.send({ works: await reorderWorks(ids as string[]) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post(
    '/admin/works/media',
    { bodyLimit: MEDIA_BODY_LIMIT },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply
          .code(400)
          .send({ error: 'work_error', message: '请以 application/octet-stream 上传图片。' });
      }
      try {
        const saved = await saveMedia(body);
        return reply.code(201).send(saved);
      } catch (error) {
        return fail(app, reply, error);
      }
    },
  );
}
