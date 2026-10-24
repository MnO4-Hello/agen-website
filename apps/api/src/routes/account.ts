/**
 * 个人中心的写入接口：资料、密码、媒体。
 *
 * 与 `/api/auth/*` 的分工：那边是「不登录也要能做的事」（注册、登录、查会话），
 * 这边**每一条都要求登录**——第一行固定是 `requireUser()`。
 *
 * 三条细节容易踩：
 *
 *   · `requireUser` 是 **async**，且它自己会写 401。拿到 null 就直接 return，
 *     不要再 `reply.send()` 一次（会抛 FST_ERR_REP_ALREADY_SENT）。
 *   · `application/octet-stream` 的解析器是**插件作用域**的，见下面的
 *     `addContentTypeParser`——`admin-works.ts` 里那份在这里看不见。
 *   · 慢操作（scrypt）要在进 `store.mutate()` 之前算完，别占着串行队列。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { moveToTrash, trashStamp } from '../admin/trash.js';
import { hashPassword, verifyPassword } from '../users/password.js';
import {
  accountMediaNameFromUrl,
  accountMediaPaths,
  saveAccountMedia,
} from '../users/profile-media.js';
import { systemBadgesOf, type MyProfile } from '../users/profile-types.js';
import { parseProfilePatch } from '../users/profile-validate.js';
import { requireUser } from '../users/session.js';
import {
  collectReferencedMedia,
  findByUsernameWithIndex,
  publicOf,
  saveProfile,
  setMedia,
  updatePasswordHash,
  type MediaKind,
} from '../users/store.js';
import type { UserRecord } from '../users/types.js';
import { checkPassword, UserError } from '../users/validate.js';
import { failUser } from './error.js';

/** 资料最大也就 8KB 的 CSS 加十几个短字段，64KB 留足了余量。 */
const PROFILE_BODY_LIMIT = 64 * 1024;

/** 头像/封面不该有 25MB——那是作品截图的量级。8MB 对一张 4K 图绑绑有余。 */
const MEDIA_BODY_LIMIT = 8 * 1024 * 1024;

const MEDIA_KINDS: readonly MediaKind[] = ['avatar', 'cover', 'background'];

function readKind(request: FastifyRequest): MediaKind {
  const raw = (request.query as { kind?: unknown }).kind;
  if (typeof raw === 'string' && (MEDIA_KINDS as readonly string[]).includes(raw)) {
    return raw as MediaKind;
  }
  throw new UserError(400, 'invalid_kind', '图片类型只能是 avatar / cover / background。');
}

async function myProfileOf(record: UserRecord): Promise<MyProfile> {
  // 注册顺序只有 `early` 徽章用得到，但它必须与真实顺序一致，所以顺手取一次 index。
  const found = await findByUsernameWithIndex(record.username);
  return {
    user: publicOf(record),
    profile: record.profile,
    meta: { lastLoginAt: record.lastLoginAt, updatedAt: record.updatedAt },
    systemBadges: systemBadgesOf(record.role, record.createdAt, found?.index ?? -1),
  };
}

/** 密码规则用的是注册那套；字段名换成 `newPassword`，前端才能红到正确的输入框。 */
function checkNewPassword(password: string): void {
  try {
    checkPassword(password);
  } catch (error) {
    if (error instanceof UserError) {
      throw new UserError(400, 'validation_error', error.message, 'newPassword');
    }
    throw error;
  }
}

/**
 * 清掉一个媒体槽位之后，把没人再引用的文件挪进回收站。
 *
 * 文件名是内容哈希 —— 两个人用同一张图会共用一份文件，所以**不能**直接删，
 * 必须先问一遍「全部记录里还有人引用吗」。
 */
async function pruneIfUnused(app: FastifyInstance, url: string): Promise<string | null> {
  const name = accountMediaNameFromUrl(url);
  if (!name) return null;
  const used = await collectReferencedMedia();
  if (used.has(url)) return null;
  const moved = await moveToTrash(accountMediaPaths.file(name), 'account-media', trashStamp());
  if (!moved) app.log.warn(`账号媒体未能移入回收站：${name}`);
  return moved;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /*
   * 裸二进制上传。**必须在自己的插件作用域里再注册一次**：Fastify 的 content-type
   * parser 跟着插件走，`admin-works.ts` / `admin-files.ts` 里注册的那两份在这里
   * 都看不见，不注册就是 415（Unsupported Media Type）。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MEDIA_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/account/profile', async (request, reply) => {
    const me = await requireUser(request, reply);
    if (!me) return;
    try {
      return reply.send(await myProfileOf(me));
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.patch('/account/profile', { bodyLimit: PROFILE_BODY_LIMIT }, async (request, reply) => {
    const me = await requireUser(request, reply);
    if (!me) return;
    try {
      const systemBadges = systemBadgesOf(me.role, me.createdAt, -1);
      const patch = parseProfilePatch(request.body, { profile: me.profile, systemBadges });

      // 改邮箱要验证当前密码：邮箱是找回账号的唯一凭据，被 CSRF 改掉等于丢号。
      if (patch.email !== undefined && patch.email !== me.email) {
        if (!patch.currentPassword) {
          throw new UserError(
            400,
            'validation_error',
            '修改邮箱需要输入当前密码。',
            'currentPassword',
          );
        }
        const ok = await verifyPassword(patch.currentPassword, me.passwordHash);
        if (!ok) {
          throw new UserError(403, 'wrong_password', '当前密码不对。', 'currentPassword');
        }
      }

      const { record } = await saveProfile(me.id, patch);
      return reply.send(await myProfileOf(record));
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.put('/account/password', async (request, reply) => {
    const me = await requireUser(request, reply);
    if (!me) return;
    try {
      const raw = (typeof request.body === 'object' && request.body !== null
        ? request.body
        : {}) as Record<string, unknown>;
      const currentPassword = typeof raw.currentPassword === 'string' ? raw.currentPassword : '';
      const newPassword = typeof raw.newPassword === 'string' ? raw.newPassword : '';
      const confirmPassword = typeof raw.confirmPassword === 'string' ? raw.confirmPassword : '';

      if (!currentPassword) {
        throw new UserError(400, 'validation_error', '请输入当前密码。', 'currentPassword');
      }
      checkNewPassword(newPassword);
      if (newPassword !== confirmPassword) {
        throw new UserError(400, 'validation_error', '两次输入的新密码不一致。', 'confirmPassword');
      }
      if (newPassword === currentPassword) {
        throw new UserError(400, 'validation_error', '新密码和旧密码一模一样。', 'newPassword');
      }

      // 旧密码不对时也走一次 scrypt（verifyPassword 内部就是），耗时是一致的。
      const ok = await verifyPassword(currentPassword, me.passwordHash);
      if (!ok) {
        throw new UserError(403, 'wrong_password', '当前密码不对。', 'currentPassword');
      }

      // 哈希在进队之前算：scrypt 要 50–80ms，占着队列会把别人的请求一起堵住。
      const hash = await hashPassword(newPassword);
      // 刻意**不**轮换会话密钥（token 的 sub 是 id）：改密码不会把其它设备踢下线。
      await updatePasswordHash(me.id, hash);
      return reply.send({ ok: true });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/account/media', { bodyLimit: MEDIA_BODY_LIMIT }, async (request, reply) => {
    const me = await requireUser(request, reply);
    if (!me) return;
    try {
      const kind = readKind(request);
      if (!Buffer.isBuffer(request.body)) {
        throw new UserError(
          400,
          'invalid_body',
          '请以 application/octet-stream 上传图片。',
        );
      }
      const saved = await saveAccountMedia(request.body);
      const record = await setMedia(me.id, kind, saved.url);
      /*
       * 返回**完整资料**而不是只回一个 URL：前端拿到后可以直接替换手里那份数据，
       * 不用再猜「coverUrl 到底有没有变」。上传/删除两个接口的形状因此一致。
       */
      return reply.code(201).send(await myProfileOf(record));
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.delete('/account/media', async (request, reply) => {
    const me = await requireUser(request, reply);
    if (!me) return;
    try {
      const kind = readKind(request);
      const old =
        kind === 'avatar'
          ? me.avatarUrl
          : kind === 'cover'
            ? me.profile.coverUrl
            : me.profile.backgroundUrl;

      const record = await setMedia(me.id, kind, '');
      if (old) await pruneIfUnused(app, old);
      return reply.send(await myProfileOf(record));
    } catch (error) {
      return failUser(app, reply, error);
    }
  });
}
