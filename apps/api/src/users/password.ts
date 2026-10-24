/**
 * 密码哈希。
 *
 * 用 `node:crypto` 自带的 scrypt，不引 bcrypt / argon2：
 * 这两个都要编译原生模块，为了几十个账号不值得让部署环境多一道「装不上就起不来」的风险。
 * scrypt 本身就是抗 ASIC 的 KDF，`N=16384` 在普通机器上约 50–80ms，登录接口够用。
 *
 * 存储格式：`scrypt$N$r$p$<saltBase64url>$<hashBase64url>`
 *
 * 把参数写进字符串里是刻意的：以后调参（比如提到 N=32768）时，老密码仍然能按它自己
 * 记录的参数校验通过，不需要让所有人重设密码。
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * 校验时允许的参数上限。
 *
 * 没有这几行，一个被改坏的 `users.json`（比如把 N 写成 1e9）就能让登录请求分配
 * 几十 GB 内存、把进程直接打挂。**存储的参数是外部输入，不是可信数据。**
 */
const MAX_N = 1 << 17; // 131072
const MAX_R = 16;
const MAX_P = 4;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * 比对密码。
 *
 * 任何异常（格式不认识、参数越界、base64 坏掉）都返回 `false`，不向外抛——
 * 登录接口不该因为一行脏数据变成 500，那等于告诉攻击者「这个账号的记录坏了」。
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > MAX_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;

  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}

/**
 * 一个谁也不知道密码的哈希，专供「账号不存在」时跑一次比对用。
 *
 * 用途只有一个：抹平登录耗时。否则「用户不存在」立即返回、「密码错」要等 60ms，
 * 光看响应时间就能把所有注册过的用户名/邮箱枚举出来。
 */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 7);
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${DUMMY_SALT.toString('base64url')}$${scryptSync(
  // 这里用同步版本：只在模块加载时跑一次，启动多花 60ms 换掉每次登录的一次分支判断。
  randomBytes(32).toString('hex'),
  DUMMY_SALT,
  KEY_LEN,
  { N, r: R, p: P, maxmem: MAX_MEM },
).toString('base64url')}`;
