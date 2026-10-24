/**
 * 公开个人主页（`#u/<用户名>`）与账号媒体的直链。
 *
 * 这一组接口**不需要登录**（`members` 档除外），所以两条纪律特别要紧：
 *
 *   · **可见性判断只有一处**（`toPublicProfile()`）。路由层不许自己判，
 *     否则早晚会出现「这个接口记得过滤、那个接口忘了」。
 *   · **不缓存**。响应随 cookie 变化（本人能看到自己隐藏的字段），被中间代理
 *     缓存下来就是隐私事故，所以统一 `no-store`。媒体直链反过来——内容哈希命名，
 *     可以永久缓存。
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { noStore } from '../admin/session.js';
import {
  accountMediaMime,
  accountMediaPaths,
  isAccountMediaName,
} from '../users/profile-media.js';
import { systemBadgesOf } from '../users/profile-types.js';
import { toPublicProfile } from '../users/profile-validate.js';
import { resolveUser } from '../users/session.js';
import { findByUsernameWithIndex, publicOf } from '../users/store.js';
import { failUser } from './error.js';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users/:username', async (request, reply) => {
    noStore(reply);
    try {
      const username = (request.params as { username?: string }).username ?? '';
      const found = await findByUsernameWithIndex(username);

      // 停用的账号**任何档位都 404**：不能因为主人自己能看见就暴露「这个号被停了」。
      if (!found || found.record.status !== 'active') {
        return reply.code(404).send({ error: 'not_found', message: '没有这个人。' });
      }

      const record = found.record;
      const viewer = await resolveUser(request);
      const isSelf = viewer !== null && viewer.id === record.id;

      if (!isSelf) {
        if (record.profile.visibility === 'private') {
          // 私有页面对外必须与「不存在」不可区分，否则可以用用户名字典批量探测谁有账号。
          return reply.code(404).send({ error: 'not_found', message: '没有这个人。' });
        }
        if (record.profile.visibility === 'members' && viewer === null) {
          // 这里给 401 而不是 404：这个档位的语义就是「登录后可见」，
          // 给 404 会让人以为链接坏了。用户名本来就是要分享出去的，不算泄漏。
          return reply.code(401).send({
            error: 'login_required',
            message: '这个主页只对登录用户开放，登录之后就能看了。',
          });
        }
      }

      return reply.send({
        profile: toPublicProfile(
          publicOf(record),
          record.profile,
          record.lastLoginAt,
          isSelf,
          systemBadgesOf(record.role, record.createdAt, found.index),
        ),
      });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.get('/account/media/:file', async (request, reply) => {
    const name = (request.params as { file?: string }).file ?? '';

    // ① 只认服务端生成的命名：同时挡掉 `..`、反斜杠、%2f 解码后的斜杠。
    if (!isAccountMediaName(name)) return reply.code(404).send({ error: 'not_found' });

    // ② realpath 复核：万一有人往媒体目录里塞了软链接，也出不去。
    const root = await accountMediaPaths.realDir();
    const real = await realpath(accountMediaPaths.file(name)).catch(() => null);
    if (!real || !real.startsWith(`${root}${path.sep}`)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) return reply.code(404).send({ error: 'not_found' });

    reply.header('content-type', accountMediaMime(name));
    reply.header('content-length', String(info.size));
    // 内容哈希命名 → 内容变了 URL 就变了，可以放心永久缓存。
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('x-content-type-options', 'nosniff');
    // 就算误传了一张能被当文档打开的图，也不许它跑脚本。
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(real));
  });
}
