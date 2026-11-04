/**
 * 管理员登录。
 *
 * 这是**隐藏入口 `/admin.html` 的后端**：页面本身不在任何导航里，且带 `noindex`，
 * 但「藏起来」不构成保护——真正拦人的是这里的账号密码校验。
 *
 * 会话的公共部分（读配置、签 token、读 cookie、统一门卫）在 `admin/session.ts`；
 * 本文件只剩「发/收 session」这三件事，外加登录失败限流。
 *
 * ⚠️ 前端 `apps/web/src/admin/*` 与本文件是一对：改字段名两边一起改。
 */

import type { FastifyInstance } from 'fastify';

import {
  adminCookieHeader,
  noStore,
  readAdminConfig,
  signToken,
  type AdminConfig,
} from '../admin/session.js';
import { resolveCurrentActor } from '../admin/guard.js';
import { isActive } from '../users/moderation.js';
import { DUMMY_HASH, verifyPassword } from '../users/password.js';
import { findByLogin } from '../users/store.js';

/** 限流窗口与窗口内允许的失败次数。 */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface AttemptRecord {
  count: number;
  /** 窗口起点（毫秒时间戳）。 */
  first: number;
}

/**
 * 失败计数表。
 *
 * 进程内内存即可：本站是单进程的，重启就把计数清零也无所谓（限流防的是在线暴力猜，
 * 不是长期审计）。键用 Fastify 的 `request.ip`（已考虑 `trustProxy` 的配置）。
 */
const attempts = new Map<string, AttemptRecord>();

/** 限流：窗口过期就当没记过，返回还能试几次。 */
function consumeAttempt(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((ATTEMPT_WINDOW_MS - (now - record.first)) / 1000),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 登录成功后清掉该 IP 的失败计数。 */
function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

interface Credentials {
  username: string;
  password: string;
}

function readCredentials(body: unknown): Credentials | null {
  if (typeof body !== 'object' || body === null) return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (username.length === 0 || password.length === 0) return null;
  return { username, password };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** 未登录 / 已登录的查询入口：前端进页面先问一次，决定显示表单还是面板。 */
  app.get('/admin/session', async (request, reply) => {
    noStore(reply);
    const config = readAdminConfig();
    if (!config) return reply.code(503).send({ error: 'admin_not_configured' });

    /*
     * 这里走 `resolveCurrentActor()`（不是只验签名）：账号被停用 / 封禁 / 降级之后
     * 必须立刻显示成「未登录」，否则前端会拿着一个已经没有权限的身份去渲染整个后台，
     * 每个请求再各吃一个 401。
     *
     * `role` 是本次新增的：左侧导航要靠它决定显示哪些分区（管理员看不到作品与徽章）。
     */
    const actor = await resolveCurrentActor(request);
    return reply.send(
      actor
        ? { authenticated: true, user: actor.name, role: actor.role, source: actor.source }
        : { authenticated: false },
    );
  });

  app.post('/admin/login', async (request, reply) => {
    noStore(reply);
    const config = readAdminConfig();
    if (!config) return reply.code(503).send({ error: 'admin_not_configured' });

    const ip = request.ip;
    const gate = consumeAttempt(ip);
    if (!gate.allowed) {
      reply.header('retry-after', String(gate.retryAfterSeconds));
      return reply.code(429).send({
        error: 'too_many_attempts',
        retryAfterSeconds: gate.retryAfterSeconds,
      });
    }

    const credentials = readCredentials(request.body);
    if (!credentials) return reply.code(400).send({ error: 'invalid_body' });

    /*
     * 唯一的登录路径：`users.json` 里的管理员 / 站长账号。
     *
     * 2026-11-04 之前这里先比一对 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD`，那是一个
     * 在 `users.json` 里查不到、也删不掉的「隐形管理员」。站长要求后台只留自己的账号，
     * 那套凭据连同这条分支一起删掉了——**别再恢复**，否则同一个站点又会多出一个
     * 谁都不认识、封不掉的身份。
     *
     * 三道细节：
     *   · 账号不存在时也跑一次 scrypt（`DUMMY_HASH`），否则「没这个人」的响应明显更快；
     *   · 停用 / 角色不够都走同一个 401，不告诉对方「你账号存在但权限不够」；
     *   · 签出来的 token 是**无状态**的，有效期内撤不掉，所以这类会话的 TTL 压到最多 2 小时。
     */
    const account = await findByLogin(credentials.username);
    const canAdmin =
      account !== null &&
      isActive(account) &&
      (account.role === 'admin' || account.role === 'owner');
    const accountPasswordOk = await verifyPassword(
      credentials.password,
      canAdmin && account ? account.passwordHash : DUMMY_HASH,
    );
    if (!account || !canAdmin || !accountPasswordOk) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    clearAttempts(ip);
    const userConfig: AdminConfig = {
      ...config,
      ttlMs: Math.min(config.ttlMs, 2 * 60 * 60 * 1000),
    };
    reply.header(
      'set-cookie',
      adminCookieHeader(
        signToken(account.username, userConfig),
        userConfig,
        Math.floor(userConfig.ttlMs / 1000),
      ),
    );
    return reply.send({
      authenticated: true,
      user: account.username,
      role: account.role,
      source: 'account',
    });
  });

  app.post('/admin/logout', async (_request, reply) => {
    noStore(reply);
    const config = readAdminConfig();
    // 没配置也要能登出（否则配错环境变量后 cookie 会留在浏览器里，越清不掉）。
    const fallback: AdminConfig = config ?? {
      secret: '',
      ttlMs: 0,
      secure: false,
    };
    reply.header('set-cookie', adminCookieHeader('', fallback, 0));
    return reply.send({ authenticated: false });
  });
}
