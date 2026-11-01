/**
 * 留言板的公开接口。
 *
 * 接口一览（全部挂在 `/api` 前缀下）：
 *
 *   GET  /messages                  留言列表：`?cursor=&limit=`（楼层号降序，最新在前）
 *   POST /messages                  发留言（登录直接发，游客要过站内人机验证）
 *   POST /messages/:id/replies      回复某条留言（同上）
 *   GET  /messages/captcha          领一道工作量证明题
 *   POST /messages/media            上传一张图（裸二进制，返回文件名）
 *   GET  /messages/media/:file      图片直链（内容哈希 → immutable 长缓存）
 *
 * 几条刻意的取舍：
 *
 *   · **列表把回复一起带回来**。留言的回复通常只有几条，再为它开一个分页接口会让前端
 *     多一层「展开→加载→再加载」的状态机；上限 100 条，超过的体现在 `replyCount` 里。
 *   · **图片只收文件名**（`m-<hash>.<ext>`），服务端按正则复核后自己拼前缀。收完整 URL
 *     等于允许留言指向任意站外资源。
 *   · **验证在内容校验之后、落库之前消费**。反过来的话，一个「内容不合法」的请求也会
 *     烧掉一张题，用户白等一次。
 *   · **游客昵称由服务端硬编码**，请求体里的任何昵称字段都不读（与博客回复一致）。
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { noStore } from '../admin/session.js';
import { activeMute, mutedMessage } from '../users/moderation.js';
import { resolveUser } from '../users/session.js';
import { loadLiveAuthors } from '../message/authors.js';
import {
  MAX_MEDIA_BYTES,
  isMessageMediaName,
  messageMediaMime,
  messageMediaPaths,
  saveMedia,
} from '../message/media.js';
import {
  addMessage,
  addReply,
  listMessages,
} from '../message/store.js';
import { toMessageView, type AuthorSnapshot } from '../message/types.js';
import {
  MessageError,
  parseMessageFields,
  parseMessageQuery,
  readId,
} from '../message/validate.js';
import { consumeChallenge, issueChallenge } from '../shared/captcha.js';
import {
  contentFingerprint,
  createDuplicateGuard,
  createLimiter,
  hashActor,
  LIMITS,
} from '../shared/guard.js';

const MESSAGE_BODY_LIMIT = 64 * 1024;
const REPLY_BODY_LIMIT = 32 * 1024;
const MEDIA_BODY_LIMIT = MAX_MEDIA_BYTES;

/** 游客的统一身份：昵称与头像都不由客户端决定。 */
const GUEST_AUTHOR: AuthorSnapshot = { kind: 'guest', id: '', nickname: '游客', avatarUrl: '' };

const captchaLimit = createLimiter(LIMITS.captcha.max, LIMITS.captcha.windowMs);
const guestShortLimit = createLimiter(LIMITS.messageGuestShort.max, LIMITS.messageGuestShort.windowMs);
const guestLongLimit = createLimiter(LIMITS.messageGuestLong.max, LIMITS.messageGuestLong.windowMs);
const userLimit = createLimiter(LIMITS.messageUser.max, LIMITS.messageUser.windowMs);
const ipLimit = createLimiter(LIMITS.messageIp.max, LIMITS.messageIp.windowMs);
const mediaGuestLimit = createLimiter(LIMITS.mediaGuest.max, LIMITS.mediaGuest.windowMs);
const mediaUserLimit = createLimiter(LIMITS.mediaUser.max, LIMITS.mediaUser.windowMs);
const duplicateGuard = createDuplicateGuard(10 * 60 * 1000);

function failMessage(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MessageError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply
    .code(500)
    .send({ error: 'message_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

function tooMany(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(429).send({
    error: 'too_many_requests',
    message: '操作太频繁了，歇一会儿再来。',
    retryAfterSeconds,
  });
}

/**
 * 发留言 / 回复前共用的三道闸：限流 → 蜜罐 → 内容校验 → 游客验证。
 *
 * 顺序有意义，别调换：限流最便宜先挡；蜜罐命中的请求不该再读盘；内容不合法就不该
 * 消耗一张题；验证是一张一次性券，必须放在最后但落库之前。
 */
async function gate(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  raw: Record<string, unknown>,
  options: { allowMarkdown: boolean },
): Promise<
  | { ok: false }
  | {
      ok: true;
      fields: ReturnType<typeof parseMessageFields>;
      author: AuthorSnapshot;
      ipHash: string;
    }
> {
  const ipHash = await hashActor(request.ip);
  const viewer = await resolveUser(request);

  /*
   * ⓪ 禁言：能登录、能看帖，只是不能发言。
   *
   * 放在限流之前——禁言是最确定的拒绝理由，没必要先扣他的额度；而且限流键对
   * 登录用户是 id，被禁言的人反复重试会把额度耗光，解禁后还要等窗口过去。
   */
  const mute = viewer ? activeMute(viewer) : null;
  if (mute) {
    void reply.code(403).send({
      error: 'muted',
      message: mutedMessage(mute),
      until: mute.until,
      reason: mute.reason,
    });
    return { ok: false };
  }

  // ① 限流（登录用户按账号、游客按 IP，再加一道 IP 兜底）
  const actorKey = viewer ? viewer.id : ipHash;
  const shortLimit = viewer ? userLimit : guestShortLimit;
  const verdict = shortLimit.consume(actorKey);
  if (!verdict.allowed) {
    tooMany(reply, verdict.retryAfterSeconds);
    return { ok: false };
  }
  const ipVerdict = ipLimit.consume(ipHash);
  if (!ipVerdict.allowed) {
    tooMany(reply, ipVerdict.retryAfterSeconds);
    return { ok: false };
  }

  // ② 蜜罐：CSS 之外的字段真人填不到。命中时给通用话术，不告诉脚本是哪条。
  if (typeof raw.website === 'string' && raw.website.trim()) {
    void reply.code(400).send({ error: 'captcha_failed', message: '验证没通过，刷新一下再试。' });
    return { ok: false };
  }

  // ③ 内容校验放在验证之前：内容不合法不该消耗一次证明题。
  let fields: ReturnType<typeof parseMessageFields>;
  try {
    fields = parseMessageFields(raw, options);
  } catch (error) {
    failMessage(app, reply, error);
    return { ok: false };
  }

  if (!viewer) {
    const longVerdict = guestLongLimit.consume(ipHash);
    if (!longVerdict.allowed) {
      tooMany(reply, longVerdict.retryAfterSeconds);
      return { ok: false };
    }

    const check = await consumeChallenge(raw.captcha);
    if (!check.ok) {
      void reply.code(400).send({ error: check.code, message: check.message });
      return { ok: false };
    }

    // ④ 同一个人 10 分钟内发同一段话 = 重复提交（也挡住了「刷新页面重发」）。
    const fingerprint = `${ipHash}:${contentFingerprint(`${fields.body}|${fields.images.join(',')}`)}`;
    if (duplicateGuard.hit(fingerprint)) {
      void reply
        .code(409)
        .send({ error: 'duplicate_content', message: '这条刚刚发过了，别重复提交。' });
      return { ok: false };
    }
  }

  const author: AuthorSnapshot = viewer
    ? { kind: 'user', id: viewer.id, nickname: viewer.nickname, avatarUrl: viewer.avatarUrl }
    : GUEST_AUTHOR;

  return { ok: true, fields, author, ipHash };
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  /*
   * 图片上传走裸二进制流。
   *
   * 必须在本插件里**再注册一次**：`admin-blog.ts` / `admin-works.ts` 里那些解析器都是
   * 各自插件作用域的，出了那个作用域就看不到（Fastify 的封装规则）。不注册的表现是 415。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MEDIA_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/messages', async (request, reply) => {
    try {
      const query = parseMessageQuery(request.query as Record<string, unknown>);
      const live = await loadLiveAuthors();
      const page = await listMessages(query);
      noStore(reply);
      return {
        messages: page.messages.map((bundle) =>
          toMessageView(bundle.record, live, bundle.replies, bundle.replyCount),
        ),
        nextCursor: page.nextCursor,
        total: page.total,
        replyTotal: page.replyTotal,
      };
    } catch (error) {
      return failMessage(app, reply, error);
    }
  });

  app.get('/messages/captcha', async (request, reply) => {
    try {
      const ipHash = await hashActor(request.ip);
      const verdict = captchaLimit.consume(ipHash);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);

      // 题目本身是每题一变的内容，绝不能缓存。
      noStore(reply);
      return await issueChallenge();
    } catch (error) {
      return failMessage(app, reply, error);
    }
  });

  /*
   * 图片直链。文件是内容哈希，可以 `immutable` 长缓存。三道校验与博客那条一模一样：
   * 命名白名单（顺带挡掉 `..` 与 `%2f`）→ realpath 复核前缀（挡软链接出逃）→ 必须是文件。
   */
  app.get('/messages/media/:file', async (request, reply) => {
    const name = (request.params as { file?: string }).file ?? '';
    if (!isMessageMediaName(name)) return reply.code(404).send({ error: 'not_found' });

    const root = await messageMediaPaths.realDir();
    const real = await realpath(messageMediaPaths.file(name)).catch(() => null);
    if (!real || !real.startsWith(`${root}${path.sep}`)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) return reply.code(404).send({ error: 'not_found' });

    reply.header('content-type', messageMediaMime(name));
    reply.header('content-length', String(info.size));
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    // 就算哪天误传了一张能被当文档打开的文件，也不许它跑脚本。
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(real));
  });

  app.post('/messages/media', { bodyLimit: MEDIA_BODY_LIMIT }, async (request, reply) => {
    try {
      const ipHash = await hashActor(request.ip);
      const viewer = await resolveUser(request);
      // 禁言期间连图片都不给传：否则他能占磁盘，却发不出带图留言，等于白占。
      const mute = viewer ? activeMute(viewer) : null;
      if (mute) {
        return reply.code(403).send({
          error: 'muted',
          message: mutedMessage(mute),
          until: mute.until,
          reason: mute.reason,
        });
      }
      const limiter = viewer ? mediaUserLimit : mediaGuestLimit;
      const verdict = limiter.consume(viewer ? viewer.id : ipHash);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);

      const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      noStore(reply);
      return reply.code(201).send(await saveMedia(buffer));
    } catch (error) {
      return failMessage(app, reply, error);
    }
  });

  app.post('/messages', { bodyLimit: MESSAGE_BODY_LIMIT }, async (request, reply) => {
    try {
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const checked = await gate(app, request, reply, raw, { allowMarkdown: true });
      if (!checked.ok) return;

      const { record, total } = await addMessage({
        mode: checked.fields.mode,
        body: checked.fields.body,
        images: checked.fields.images,
        author: checked.author,
        ipHash: checked.ipHash,
      });

      const live = await loadLiveAuthors();
      noStore(reply);
      return reply.code(201).send({ message: toMessageView(record, live), total });
    } catch (error) {
      return failMessage(app, reply, error);
    }
  });

  app.post('/messages/:id/replies', { bodyLimit: REPLY_BODY_LIMIT }, async (request, reply) => {
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      // 回复只有纯文本 + 图片，不开放 Markdown。
      const checked = await gate(app, request, reply, raw, { allowMarkdown: false });
      if (!checked.ok) return;

      const { record, replyCount } = await addReply(id, {
        body: checked.fields.body,
        images: checked.fields.images,
        author: checked.author,
        ipHash: checked.ipHash,
      });

      const live = await loadLiveAuthors();
      noStore(reply);
      return reply.code(201).send({ reply: toMessageView(record, live), replyCount });
    } catch (error) {
      return failMessage(app, reply, error);
    }
  });
}
