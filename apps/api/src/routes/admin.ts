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
  ADMIN_COOKIE,
  adminCookieHeader,
  noStore,
  readAdminConfig,
  readCookie,
  sameSecret,
  signToken,
  verifyToken,
  type AdminConfig,
} from '../admin/session.js';
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

    const token = readCookie(request, ADMIN_COOKIE);
    const user = token ? verifyToken(token, config.secret) : null;
    // 未登录也是 200：这是「状态查询」而不是权限校验，前端据此渲染，不该走错误分支。
    return reply.send(user ? { authenticated: true, user } : { authenticated: false });
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

    // 两个条件都要算完再判断，别用 `||` 短路：短路会让「用户名就错了」比「密码错了」
    // 少一次摘要计算，理论上能通过耗时区分两者。
    const userOk = sameSecret(credentials.username, config.user);
    const passwordOk = sameSecret(credentials.password, config.password);
    if (userOk && passwordOk) {
      clearAttempts(ip);
      reply.header(
        'set-cookie',
        adminCookieHeader(signToken(config.user, config), config, Math.floor(config.ttlMs / 1000)),
      );
      return reply.send({ authenticated: true, user: config.user });
    }

    /*
     * 第二条路：`users.json` 里的管理员 / 站长账号。
     *
     * 这是「账号系统」与「隐藏后台」唯一的交点——站长在前面注册的账号，应该能直接
     * 登进后台，而不必再去 `.env` 里手抄一份密码。普通用户一律进不来（role 不在白名单）。
     *
     * 三道细节：
     *   · 账号不存在时也跑一次 scrypt（`DUMMY_HASH`），否则「没这个人」的响应明显更快；
     *   · 停用 / 角色不够都走同一个 401，不告诉对方「你账号存在但权限不够」；
     *   · 签出来的 token 与原 `.env` 管理员**同构**，`requireAdmin` 一行都不用改。
     *     代价是无状态 token 在有效期内无法撤销，所以这类会话的 TTL 压到最多 2 小时。
     */
    const account = await findByLogin(credentials.username);
    const canAdmin =
      account !== null &&
      account.status === 'active' &&
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
    return reply.send({ authenticated: true, user: account.username });
  });

  app.post('/admin/logout', async (_request, reply) => {
    noStore(reply);
    const config = readAdminConfig();
    // 没配置也要能登出（否则配错环境变量后 cookie 会留在浏览器里，越清不掉）。
    const fallback: AdminConfig = config ?? {
      user: '',
      password: '',
      secret: '',
      ttlMs: 0,
      secure: false,
    };
    reply.header('set-cookie', adminCookieHeader('', fallback, 0));
    return reply.send({ authenticated: false });
  });
}
