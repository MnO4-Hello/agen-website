/**
 * 博客的公开接口。
 *
 * 接口一览（全部挂在 `/api` 前缀下）：
 *
 *   GET  /blog/posts                 列表：`?q=&cat=&tag=&sort=new|hot&cursor=&limit=`
 *   GET  /blog/posts/:slug           详情 + 第一页回复
 *   GET  /blog/posts/:slug/replies   回复分页（按楼层号游标）
 *   GET  /blog/categories            分类（带已发布计数）
 *   GET  /blog/tags                  热门标签
 *   GET  /blog/captcha               领一道工作量证明题（ALTCHA 形状）
 *   POST /blog/posts/:slug/replies   发回复（登录用户 / 刚过验证的游客）
 *   POST /blog/posts/:slug/vote      给帖子投票（登录）
 *   POST /blog/replies/:id/vote      给回复投票（登录）
 *
 * 几条刻意的取舍：
 *
 *   · **读接口也带 cookie 语义**（`myVote` 依赖当前用户），所以一律 `no-store`。
 *   · **参数脏不报错**：`limit` 越界夹紧、`sort` 未知回落、`q` 截断——列表页白屏比
 *     「参数不合法」难看得多。唯一例外是 `cursor`，坏了必须让前端从头拉。
 *   · **验证码在内容校验之后、落库之前消费**。反过来的话，一个「帖子已关闭」的请求
 *     也会烧掉一张题，用户白做一次。
 *   · **游客昵称由服务端硬编码**，请求体里的任何昵称字段都不读。「游客」是一个统一
 *     身份，一旦允许自填就再也认不出「同一个人」，也没法拿楼层号区分。
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { noStore } from '../admin/session.js';
import { activeMute, mutedMessage } from '../users/moderation.js';
import { resolveUser, requireUser } from '../users/session.js';
import { loadLiveAuthors } from '../blog/authors.js';
import {
  blogMediaMime,
  blogMediaPaths,
  isBlogMediaName,
} from '../blog/media.js';
import { consumeChallenge, issueChallenge } from '../shared/captcha.js';
import {
  contentFingerprint,
  createDuplicateGuard,
  createLimiter,
  hashActor,
  LIMITS,
} from '../shared/guard.js';
import {
  addReply,
  findPostPage,
  listCategories,
  listPosts,
  listReplies,
  listTags,
  setPostVote,
  setReplyVote,
} from '../blog/store.js';
import { pickReply, type AuthorSnapshot } from '../blog/types.js';
import {
  BlogError,
  isSlug,
  parsePostQuery,
  parseReplyFields,
  parseVote,
  queryValue,
  DEFAULT_REPLY_PAGE_SIZE,
} from '../blog/validate.js';

const REPLY_BODY_LIMIT = 16 * 1024;
const VOTE_BODY_LIMIT = 4 * 1024;

/** 游客的统一身份：昵称与头像都不由客户端决定。 */
const GUEST_AUTHOR: AuthorSnapshot = { kind: 'guest', id: '', nickname: '游客', avatarUrl: '' };

const captchaLimit = createLimiter(LIMITS.captcha.max, LIMITS.captcha.windowMs);
const guestShortLimit = createLimiter(LIMITS.guestReplyShort.max, LIMITS.guestReplyShort.windowMs);
const guestLongLimit = createLimiter(LIMITS.guestReplyLong.max, LIMITS.guestReplyLong.windowMs);
const userReplyLimit = createLimiter(LIMITS.userReply.max, LIMITS.userReply.windowMs);
const ipReplyLimit = createLimiter(LIMITS.ipReply.max, LIMITS.ipReply.windowMs);
const voteLimit = createLimiter(LIMITS.vote.max, LIMITS.vote.windowMs);
const duplicateGuard = createDuplicateGuard(10 * 60 * 1000);

function failBlog(app: FastifyInstance, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BlogError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  app.log.error(error);
  return reply.code(500).send({ error: 'blog_error', message: '服务器内部错误，请看一眼后端控制台。' });
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found', message: '没有这篇帖子，可能已经被删掉了。' });
}

function tooMany(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(429).send({
    error: 'too_many_requests',
    message: '操作太频繁了，歇一会儿再来。',
    retryAfterSeconds,
  });
}

/** slug 形状先挡一道：合法的 slug 才值得读一次数据文件。 */
function readSlug(params: unknown): string | null {
  const raw = (params as { slug?: unknown }).slug;
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  return isSlug(slug) ? slug : null;
}

export async function blogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/blog/posts', async (request, reply) => {
    try {
      const query = parsePostQuery(request.query as Record<string, unknown>);
      const viewer = await resolveUser(request);
      const live = await loadLiveAuthors();
      noStore(reply);
      return await listPosts(query, viewer?.id ?? null, live);
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.get('/blog/posts/:slug', async (request, reply) => {
    try {
      const slug = readSlug(request.params);
      if (!slug) return notFound(reply);
      const viewer = await resolveUser(request);
      const live = await loadLiveAuthors();
      const page = await findPostPage(slug, viewer?.id ?? null, live, DEFAULT_REPLY_PAGE_SIZE);
      if (!page) return notFound(reply);
      noStore(reply);
      return page;
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.get('/blog/posts/:slug/replies', async (request, reply) => {
    try {
      const slug = readSlug(request.params);
      if (!slug) return notFound(reply);
      const viewer = await resolveUser(request);
      const live = await loadLiveAuthors();
      noStore(reply);
      return await listReplies(slug, request.query as Record<string, unknown>, viewer?.id ?? null, live);
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  /*
   * 帖子插图直链。
   *
   * 文件名是内容哈希（`b-<sha1前16>.png`），所以可以 `immutable` 长缓存。三道校验
   * 与作品那条一模一样：命名白名单（顺带挡掉 `..` 与 `%2f`）→ realpath 复核前缀
   * （挡软链接出逃）→ 必须是文件。
   */
  app.get('/blog/media/:file', async (request, reply) => {
    const name = (request.params as { file?: string }).file ?? '';
    if (!isBlogMediaName(name)) return reply.code(404).send({ error: 'not_found' });

    const root = await blogMediaPaths.realDir();
    const real = await realpath(blogMediaPaths.file(name)).catch(() => null);
    if (!real || !real.startsWith(`${root}${path.sep}`)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) return reply.code(404).send({ error: 'not_found' });

    reply.header('content-type', blogMediaMime(name));
    reply.header('content-length', String(info.size));
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    // 就算哪天误传了一张能被当文档打开的文件，也不许它跑脚本。
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(real));
  });

  app.get('/blog/categories', async (_request, reply) => {
    try {
      noStore(reply);
      return { categories: await listCategories() };
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.get('/blog/tags', async (request, reply) => {
    try {
      const raw = Number.parseInt(queryValue((request.query as Record<string, unknown>).limit), 10);
      const limit = Number.isFinite(raw) ? Math.min(80, Math.max(1, raw)) : 40;
      noStore(reply);
      return { tags: await listTags(limit) };
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.get('/blog/captcha', async (request, reply) => {
    try {
      const ipHash = await hashActor(request.ip);
      const verdict = captchaLimit.consume(ipHash);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);

      // 题目本身是每题一变的内容，绝不能缓存。
      noStore(reply);
      return await issueChallenge();
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.post('/blog/posts/:slug/replies', { bodyLimit: REPLY_BODY_LIMIT }, async (request, reply) => {
    try {
      const slug = readSlug(request.params);
      if (!slug) return notFound(reply);

      const ipHash = await hashActor(request.ip);
      const viewer = await resolveUser(request);

      // ⓪ 禁言：最确定的拒绝理由，放在限流之前（理由同 messages.ts 的 gate）。
      const mute = viewer ? activeMute(viewer) : null;
      if (mute) {
        return reply.code(403).send({
          error: 'muted',
          message: mutedMessage(mute),
          until: mute.until,
          reason: mute.reason,
        });
      }

      // ① 限流（先挡最便宜的一道，避免下面每一步被反复触发）
      const actorKey = viewer ? viewer.id : ipHash;
      const shortLimit = viewer ? userReplyLimit : guestShortLimit;
      const verdict = shortLimit.consume(actorKey);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);
      const ipVerdict = ipReplyLimit.consume(ipHash);
      if (!ipVerdict.allowed) return tooMany(reply, ipVerdict.retryAfterSeconds);

      const raw = (request.body ?? {}) as Record<string, unknown>;

      // ② 蜜罐：CSS 藏起来的字段，真人填不到。命中时给通用话术，不告诉脚本是哪条。
      if (typeof raw.website === 'string' && raw.website.trim()) {
        return reply.code(400).send({ error: 'captcha_failed', message: '验证没通过，刷新一下再试。' });
      }

      // ③ 内容校验放在验证之前：内容不合法就不该消耗一次验证。
      const fields = parseReplyFields(raw);

      if (!viewer) {
        const longVerdict = guestLongLimit.consume(ipHash);
        if (!longVerdict.allowed) return tooMany(reply, longVerdict.retryAfterSeconds);

        // 工作量证明：整个解（原题 + number）一次交回来，服务端一次哈希验完。
        // 「填得太快」由服务端从 salt 里的 expires 反推签发时间判断，不看客户端自报。
        const check = await consumeChallenge(raw.captcha);
        if (!check.ok) return reply.code(400).send({ error: check.code, message: check.message });

        // ④ 同一个人 10 分钟内发同一段话 = 重复提交（也挡住了「刷新页面重发」）。
        const fingerprint = `${ipHash}:${contentFingerprint(fields.body)}`;
        if (duplicateGuard.hit(fingerprint)) {
          return reply
            .code(409)
            .send({ error: 'duplicate_content', message: '这段回复刚刚发过了，别重复提交。' });
        }
      }

      const author: AuthorSnapshot = viewer
        ? {
            kind: 'user',
            id: viewer.id,
            nickname: viewer.nickname,
            avatarUrl: viewer.avatarUrl,
          }
        : GUEST_AUTHOR;

      const { reply: record, replyCount } = await addReply(slug, {
        body: fields.body,
        replyToFloor: fields.replyToFloor,
        author,
        ipHash,
      });

      const live = await loadLiveAuthors();
      noStore(reply);
      return reply.code(201).send({
        reply: pickReply(record, live, viewer?.id ?? null),
        replyCount,
      });
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.post('/blog/posts/:slug/vote', { bodyLimit: VOTE_BODY_LIMIT }, async (request, reply) => {
    try {
      const viewer = await requireUser(request, reply);
      if (!viewer) return;

      const slug = readSlug(request.params);
      if (!slug) return notFound(reply);

      const verdict = voteLimit.consume(viewer.id);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);

      const value = parseVote(((request.body ?? {}) as Record<string, unknown>).value);
      noStore(reply);
      return await setPostVote(slug, viewer.id, value);
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });

  app.post('/blog/replies/:id/vote', { bodyLimit: VOTE_BODY_LIMIT }, async (request, reply) => {
    try {
      const viewer = await requireUser(request, reply);
      if (!viewer) return;

      const id = (request.params as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) {
        return reply.code(404).send({ error: 'not_found', message: '没有这条回复。' });
      }

      const verdict = voteLimit.consume(viewer.id);
      if (!verdict.allowed) return tooMany(reply, verdict.retryAfterSeconds);

      const value = parseVote(((request.body ?? {}) as Record<string, unknown>).value);
      noStore(reply);
      return await setReplyVote(id, viewer.id, value);
    } catch (error) {
      return failBlog(app, reply, error);
    }
  });
}
