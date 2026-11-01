/**
 * 管理后台的「留言」接口。
 *
 * 接口一览（全部挂在 `/api` 前缀下，**每一个**都要 `requireAdmin`）：
 *
 *   GET  /admin/messages                 全部留言：`?status=&q=&cursor=&limit=`
 *   POST /admin/messages/:id/status      隐藏 / 恢复（软删，`visible | hidden`）
 *   POST /admin/messages/:id/replies     以站长身份回复
 *
 * 两条纪律：
 *
 *   · **只软删，不硬删**。留言底下的回复、以及别人对它的引用都靠「留下这条记录」才
 *     成立；真删了就是一片查不出来的空洞。恢复是一条独立的路，硬删没有路。
 *   · **别自己判 cookie**，统一走 `requireAdmin`（`admin/session.ts:135`），它同时负责
 *     `no-store` 头与 503「后台没配置」的分支。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireAdmin } from '../admin/session.js';
import { loadLiveAuthors, ownerIdentity } from '../message/authors.js';
import {
  addReply,
  listMessagesForAdmin,
  setMessageStatus,
} from '../message/store.js';
import { toAdminMessageView, type MessageStatus } from '../message/types.js';
import {
  MessageError,
  parseAdminMessageQuery,
  parseMessageFields,
  readId,
} from '../message/validate.js';

const JSON_BODY_LIMIT = 32 * 1024;

function fail(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MessageError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply
    .code(500)
    .send({ error: 'message_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

function readStatus(value: unknown): MessageStatus {
  if (value === 'visible' || value === 'hidden') return value;
  throw new MessageError(400, 'validation_error', 'status 只能是 visible 或 hidden。');
}

export async function adminMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/messages', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const query = parseAdminMessageQuery(request.query as Record<string, unknown>);
      const live = await loadLiveAuthors();
      const page = await listMessagesForAdmin(query);
      return {
        messages: page.messages.map((bundle) =>
          toAdminMessageView(bundle.record, live, bundle.replies, bundle.replyCount),
        ),
        nextCursor: page.nextCursor,
        total: page.total,
      };
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post(
    '/admin/messages/:id/status',
    { bodyLimit: JSON_BODY_LIMIT },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const id = readId((request.params as { id?: unknown }).id);
        const raw = (request.body ?? {}) as Record<string, unknown>;
        const record = await setMessageStatus(id, readStatus(raw.status));
        const live = await loadLiveAuthors();
        return { message: toAdminMessageView(record, live) };
      } catch (error) {
        return fail(app, reply, error);
      }
    },
  );

  app.post(
    '/admin/messages/:id/replies',
    { bodyLimit: JSON_BODY_LIMIT },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      try {
        const id = readId((request.params as { id?: unknown }).id);
        const raw = (request.body ?? {}) as Record<string, unknown>;
        // 后台回复不开放 Markdown、也不带图：它的用途是「把话说清楚」，不是排版。
        const fields = parseMessageFields(raw, { allowMarkdown: false });

        const author = await ownerIdentity();
        const { record, replyCount } = await addReply(id, {
          body: fields.body,
          images: [],
          author,
          // 后台回复不是刷屏入口，给一个固定标记即可：它不参与限流，也不做同文去重。
          ipHash: 'admin',
        });

        const live = await loadLiveAuthors();
        return reply.code(201).send({
          reply: toAdminMessageView(record, live),
          replyCount,
        });
      } catch (error) {
        return fail(app, reply, error);
      }
    },
  );
}
