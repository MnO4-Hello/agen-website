/**
 * 站点账号的会话：签发 / 校验 token、写 cookie、把请求解析成「当前是谁」。
 *
 * 形状照抄 `admin/session.ts`（无状态 HMAC token + HttpOnly cookie），但有三处**故意不同**：
 *
 *   1. **secret 缺失时不 fail-closed，而是自动生成**。`admin` 那套要求三件环境变量缺一
 *      就 503，因为「忘了配管理员密码」必须等于打不开门；但账号系统是给普通访客注册用的，
 *      没配 secret 就整站不能注册，只会让人以为站点坏了。所以缺省时在
 *      `apps/api/data/.session-secret` 生成 32 字节随机串（0600）并持久化——
 *      既是随机强密钥，也不会因为重启把所有人踢下线。
 *   2. **`sub` 是 `user.id` 而不是用户名**。改名不该让人掉线，删号则必须立刻失效，
 *      所以每次会话都要回表查一次（`resolveUser`）。
 *   3. **有效期 7 天**。访客不该每天重登一次；后台那边仍是 8 小时。
 *
 * `readCookie` / `noStore` / `sameSecret` 直接从 `admin/session.ts` 借——它们跟「管理员」
 * 没有关系，是通用的 cookie 与摘要工具。**别在这里再抄一份**，否则改 cookie 解析规则时
 * 会漏掉一半的接口。
 */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { noStore, readCookie, sameSecret } from '../admin/session.js';
import { findById } from './store.js';
import type { UserRecord } from './types.js';

export const USER_COOKIE = 'agen_user';

/** 默认 7 天。 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');

export interface UserSessionConfig {
  secret: string;
  ttlMs: number;
  secure: boolean;
}

/**
 * 从磁盘拿（或首次生成）会话密钥。
 *
 * `wx` 是原子的「不存在才创建」，两个进程同时启动时只有一个能写成功，
 * 另一个拿到 EEXIST 后重新读——不会出现两边各用一份密钥、互相认为对方 token 无效。
 */
async function fileSecret(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const existing = (await readFile(SECRET_FILE, 'utf8')).trim();
    if (existing.length >= 32) return existing;
    // 文件存在但内容不对（空文件、被人手改短了）：当作没有，重写一份。
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const secret = randomBytes(32).toString('hex');
  const handle = await open(SECRET_FILE, 'w', 0o600);
  try {
    await handle.writeFile(secret, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return secret;
}

let cached: Promise<UserSessionConfig> | null = null;

/** 缓存的是 Promise 而不是结果：并发进来的头几个请求只会触发一次读盘。 */
export function readUserSessionConfig(): Promise<UserSessionConfig> {
  cached ??= loadConfig();
  return cached;
}

async function loadConfig(): Promise<UserSessionConfig> {
  const ttlRaw = Number(process.env.USER_SESSION_TTL_MS);
  const envSecret = process.env.USER_SESSION_SECRET?.trim();
  // 环境变量里给了太短的值，宁可忽略它——用弱密钥比用自动生成的强随机串危险得多。
  const secret = envSecret && envSecret.length >= 32 ? envSecret : await fileSecret();

  return {
    secret,
    ttlMs: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS,
    // 本机 http 调试时打开 Secure 会让浏览器直接丢掉 cookie（表现为「登录成功但一刷新就掉」），
    // 所以只认显式开关，不比照 NODE_ENV 自动判断。
    secure: process.env.USER_COOKIE_SECURE === '1',
  };
}

export function signUserToken(userId: string, config: UserSessionConfig): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, ver: 1, exp: Date.now() + config.ttlMs }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', config.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** 校验通过返回 `userId`；签名不对、结构不对、过期都返回 null（对外没有区别）。 */
export function verifyUserToken(token: string, secret: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!sameSecret(signature, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      ver?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return null;
    // `ver` 留给以后换算法；现在只认 1，别的版本一律当无效。
    if (parsed.ver !== 1) return null;
    if (parsed.exp <= Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

export function userCookieHeader(
  token: string,
  config: UserSessionConfig,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${USER_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 登出用：把 cookie 立刻作废。不依赖 secret（读不到配置也要能登出）。 */
export function clearedUserCookieHeader(): string {
  return userCookieHeader(
    '',
    { secret: '', ttlMs: 0, secure: process.env.USER_COOKIE_SECURE === '1' },
    0,
  );
}

/**
 * 这个请求是谁。
 *
 * 每次都要回表：token 里只有 id，角色、昵称、是否停用都可能已经变了。
 * 多一次 JSON 读换「改完数据立刻生效」，对几十个账号的量级完全划算。
 */
export async function resolveUser(request: FastifyRequest): Promise<UserRecord | null> {
  const config = await readUserSessionConfig();
  const token = readCookie(request, USER_COOKIE);
  const userId = token ? verifyUserToken(token, config.secret) : null;
  if (!userId) return null;

  const record = await findById(userId);
  if (!record || record.status !== 'active') return null;
  return record;
}

/**
 * 需要登录的接口的统一门卫（本期的占位页接口还没用上，留给「设置 / 我的主页」落地时接）。
 *
 * 与 `requireAdmin` 同一种用法：返回 null 表示已经替调用方写好 401。
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UserRecord | null> {
  noStore(reply);
  const user = await resolveUser(request);
  if (!user) {
    void reply.code(401).send({ error: 'unauthorized', message: '请先登录。' });
    return null;
  }
  return user;
}
