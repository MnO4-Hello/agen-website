/**
 * 管理后台的博客接口。每条路由的第一行都是 `requireAdmin()`——**别自己判 cookie**。
 *
 *   GET    /api/admin/blog/meta                    —— 编辑器初始化（作者署名 + 分类）
 *   GET    /api/admin/blog/posts                   —— 全部（含草稿）`?status=&cat=&q=`
 *   GET    /api/admin/blog/posts/:id               —— 单篇（含正文，不含回复列表）
 *   POST   /api/admin/blog/posts                   —— 新建
 *   PUT    /api/admin/blog/posts/:id               —— 局部更新（只传一个字段也行）
 *   POST   /api/admin/blog/posts/:id/status        —— 发布 / 下架
 *   DELETE /api/admin/blog/posts/:id               —— 删帖（连同它的回复，不可撤销）
 *   GET    /api/admin/blog/posts/:id/replies       —— 回复列表（含被隐藏的正文）
 *   POST   /api/admin/blog/replies/:id/status      —— 隐藏 / 恢复一条回复
 *   GET    /api/admin/blog/categories              —— 分类（含草稿计数）
 *   POST   /api/admin/blog/categories              —— 新建分类
 *   PUT    /api/admin/blog/categories/:id          —— 改名
 *   DELETE /api/admin/blog/categories/:id          —— 删除（有帖子引用时 409）
 *   POST   /api/admin/blog/categories/reorder      —— 按 id 顺序重排（必须全量置换）
 *
 *   POST   /api/admin/blog/media                   —— 上传帖子插图（裸 octet-stream）
 *
 * **没有「删回复」这个接口**，只有改状态：楼层号一旦断档，帖子里所有 `#n` 引用都会
 * 集体错位，且无法修复（见 `blog/store.ts` 的第 3 条纪律）。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireAdmin } from '../admin/session.js';
import { loadLiveAuthors, ownerIdentity } from '../blog/authors.js';
import { MAX_MEDIA_BYTES, saveMedia } from '../blog/media.js';
import {
  createCategory,
  createPost,
  findPostById,
  listAdminPosts,
  listAdminReplies,
  listCategories,
  removeCategory,
  removePost,
  reorderCategories,
  setPostStatus,
  setReplyStatus,
  updateCategory,
  updatePost,
} from '../blog/store.js';
import { pickReply, replyCountOf, scoreOf, tally } from '../blog/types.js';
import type { PostRecord, PostStatus, ReplyStatus } from '../blog/types.js';
import { BlogError, queryValue } from '../blog/validate.js';

const JSON_BODY_LIMIT = 1024 * 1024;
const MEDIA_BODY_LIMIT = MAX_MEDIA_BYTES;

function fail(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BlogError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: 'blog_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

function readId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  // UUID 的实际格式不重要，只要求「非空且不含路径字符」，避免拼出奇怪的日志行。
  if (!id || id.length > 64 || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new BlogError(404, 'not_found', '没有这条记录。');
  }
  return id;
}

/** 编辑器的视图：去掉 `replies`（可能几百条）与 `votes`（一堆 userId），只留分数。 */
function editorView(record: PostRecord): Record<string, unknown> {
  const { replies, votes, ...rest } = record;
  const { up, down } = tally(votes);
  return { ...rest, up, down, score: scoreOf(votes), replyCount: replyCountOf(record) };
}

export async function adminBlogRoutes(app: FastifyInstance): Promise<void> {
  /*
   * 图片上传走裸二进制流。
   *
   * 必须在本插件里**再注册一次**：`admin-works.ts` 里那个解析器是它自己插件作用域的，
   * 出了那个作用域就看不到（Fastify 的封装规则）。不注册的表现是上传 415。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MEDIA_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/admin/blog/media', { bodyLimit: MEDIA_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      return reply.code(201).send(await saveMedia(buffer));
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/admin/blog/meta', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      return reply.send({
        author: await ownerIdentity(),
        categories: await listCategories(true),
      });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/admin/blog/posts', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const raw = request.query as Record<string, unknown>;
      const statusRaw = queryValue(raw.status);
      const status: PostStatus | '' =
        statusRaw === 'draft' || statusRaw === 'published' ? statusRaw : '';
      const live = await loadLiveAuthors();
      const posts = await listAdminPosts(
        { q: queryValue(raw.q), status, categoryId: queryValue(raw.cat ?? raw.category) },
        live,
      );
      return reply.send({ posts });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/admin/blog/posts/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const record = await findPostById(readId((request.params as { id?: unknown }).id));
      if (!record) throw new BlogError(404, 'not_found', '没有这篇帖子，可能已经被删掉了。');
      return reply.send({ post: editorView(record) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/blog/posts', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const record = await createPost(request.body, await ownerIdentity());
      return reply.code(201).send({ post: editorView(record) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.put('/admin/blog/posts/:id', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const id = readId((request.params as { id?: unknown }).id);
      return reply.send({ post: editorView(await updatePost(id, request.body)) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/blog/posts/:id/status', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (status !== 'draft' && status !== 'published') {
      return reply.code(400).send({ error: 'validation_error', message: 'status 只能是 draft 或 published。' });
    }
    try {
      const id = readId((request.params as { id?: unknown }).id);
      return reply.send({ post: editorView(await setPostStatus(id, status)) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.delete('/admin/blog/posts/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const result = await removePost(id);
      return reply.send({ ok: true, removedReplies: result.removedReplies });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/admin/blog/posts/:id/replies', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const live = await loadLiveAuthors();
      return reply.send(await listAdminReplies(id, request.query as Record<string, unknown>, live));
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/blog/replies/:id/status', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    if (status !== 'visible' && status !== 'hidden') {
      return reply.code(400).send({ error: 'validation_error', message: 'status 只能是 visible 或 hidden。' });
    }
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const record = await setReplyStatus(id, status as ReplyStatus);
      const live = await loadLiveAuthors();
      // 后台要看到被隐藏楼层的正文，否则「复核」无从下手。
      return reply.send({ reply: pickReply(record, live, null, true) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.get('/admin/blog/categories', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      return reply.send({ categories: await listCategories(true) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/blog/categories', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      return reply.code(201).send({ category: await createCategory(request.body) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.put('/admin/blog/categories/:id', { bodyLimit: JSON_BODY_LIMIT }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const id = readId((request.params as { id?: unknown }).id);
      return reply.send({ category: await updateCategory(id, request.body) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.delete('/admin/blog/categories/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const id = readId((request.params as { id?: unknown }).id);
      await removeCategory(id);
      return reply.send({ ok: true });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/admin/blog/categories/reorder', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return reply.code(400).send({ error: 'validation_error', message: 'ids 必须是字符串数组。' });
    }
    try {
      return reply.send({ categories: await reorderCategories(ids as string[]) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });
}
