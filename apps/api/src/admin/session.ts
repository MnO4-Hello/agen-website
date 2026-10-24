/**
 * 管理员会话的公共部分：读配置、签发/校验 token、读写 cookie、以及「这个请求是不是管理员」。
 *
 * 从 `routes/admin.ts` 拆出来的原因很实际：登录接口只在一处用得到，但**后面每一个管理接口**
 * （控制台日志、文件管理）都要做同一道校验。校验逻辑只留一份，才不会出现「某个接口忘了挡」。
 *
 * 设计取舍（每条都有代价，别轻易改）：
 *
 *   1. **凭据只从环境变量读**（`ADMIN_USER` / `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET`）：
 *      仓库里不留任何可登录的默认值。三个变量缺任何一个就整体 503（fail-closed）——
 *      「忘了配」必须是打不开门，而不是谁都能进。
 *   2. **会话是无状态 HMAC token，放在 HttpOnly cookie 里**：token 不进 JS 作用域，
 *      XSS 偷不走；服务端不用存 session 表。token 里只有 `{ sub, exp }`，没有密码。
 *      代价：登出只能删客户端 cookie，已签发的 token 在过期前理论上仍有效（本机自用足够）。
 *   3. **`Secure` 属性只由 `ADMIN_COOKIE_SECURE=1` 打开**：本机 http 调试时打开它
 *      浏览器会直接丢掉这颗 cookie（表现为「登录成功但一刷新就退回登录页」），
 *      所以不能按 `NODE_ENV` 自动判断。
 *
 * ⚠️ 前端 `apps/web/src/admin/*` 与本文件是一对：改字段名两边一起改。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Cookie 名。前端不读它（HttpOnly），只由浏览器自动带上。 */
export const ADMIN_COOKIE = 'agen_admin';

/** 会话默认有效期：8 小时。 */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export interface AdminConfig {
  user: string;
  password: string;
  secret: string;
  ttlMs: number;
  secure: boolean;
}

/** 每次请求现读环境变量：测试可以随时改，且不必在模块加载期就要求变量存在。 */
export function readAdminConfig(): AdminConfig | null {
  const user = process.env.ADMIN_USER?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (!user || !password || !secret) return null;

  const ttlMs = Number(process.env.ADMIN_SESSION_TTL_MS);
  return {
    user,
    password,
    secret,
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
    secure: process.env.ADMIN_COOKIE_SECURE === '1',
  };
}

/** 定长比较：先把两边各自摘要成 32 字节，长度自然对齐，再逐字节比。 */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** 签发 token：`<base64url(payload)>.<base64url(hmac)>`，无状态、可自校验。 */
export function signToken(user: string, config: AdminConfig): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: user, exp: Date.now() + config.ttlMs }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', config.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** 校验 token：签名不对、结构不对、过期都返回 null（三种情况对外没有区别）。 */
export function verifyToken(token: string, secret: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!sameSecret(signature, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp <= Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

/** 读请求里的 cookie（只认这一个名字，不引 @fastify/cookie）。 */
export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function adminCookieHeader(token: string, config: AdminConfig, maxAgeSeconds: number): string {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 这几个接口的响应一律不许缓存（含 401，否则代理可能把「未登录」缓存下来）。 */
export function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

/**
 * 管理接口的统一门卫。
 *
 * - 返回 `string`（用户名）= 已登录，继续处理；
 * - 返回 `null` = 已经替调用方写好响应（503 未配置 / 401 未登录），调用方直接 `return`。
 *
 * 这样每个路由开头都只有一行 `if (!requireAdmin(request, reply)) return;`，
 * 比在每处重复 `config` 判空 + token 校验更不容易写漏。
 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply): string | null {
  noStore(reply);
  const config = readAdminConfig();
  if (!config) {
    void reply.code(503).send({ error: 'admin_not_configured' });
    return null;
  }

  const token = readCookie(request, ADMIN_COOKIE);
  const user = token ? verifyToken(token, config.secret) : null;
  if (!user) {
    void reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return user;
}
