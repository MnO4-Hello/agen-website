/**
 * 站内人机验证：自托管的 SHA-256 工作量证明（PoW）。
 *
 * 位置：`shared/` —— 留言板与博客共用同一套题。题目、签名、防重放这三件事与
 * 「验证通过之后要干什么」无关，各自领域只决定「什么时候要求验」。
 *
 * ## 为什么换成这个
 *
 * 原来的算术题有三条硬伤：① 题型固定，一条正则就能解；② 服务端要存一张「题目 → 答案」
 * 的表，重启即失效、还要自己清扫；③ 每次都要用户读题打字，体验比点一下差。
 *
 * 这里的做法与 **ALTCHA**（github.com/altcha-org/altcha）和 **Cap**
 * （github.com/tiagorangel1/cap）同一个思路：服务端出一道**没有视觉题的**证明题，
 * 客户端算几百毫秒把答案找出来，服务端一次哈希就能验完。
 *
 *   · 不发任何第三方请求 → 国内网络没有任何问题（Turnstile / hCaptcha 在这件事上
 *     是反例：脚本从境外加载，经常转圈到超时）。
 *   · 零依赖 → 服务端只用 `node:crypto`，前端只有一个自写的 sha256（见
 *     `apps/web/src/blog/sha256.ts`），不引 altcha / @cap.js/widget 那 20KB 的包。
 *   · 无状态 → 服务端**不存答案**，只存「已经用过的 challenge id」（防重放）。
 *
 * ## 协议（载荷形状与 ALTCHA 一致，签名串是本仓库自己定的字段顺序）
 *
 *   出题：随机 `number ∈ [0, maxnumber]`，`challenge = SHA-256(salt + number)`。
 *        因为哈希不可逆，客户端只能从 0 开始逐个试，平均试 `maxnumber / 2` 次。
 *   验题：`SHA-256(salt + number) === challenge` 且签名对得上 且没过期 且没用过。
 *
 * `salt` 里带 `?expires=<毫秒时间戳>&id=<一次性 nonce>`：过期时间因此**不需要服务端
 * 存储**，也就能从 `expires - TTL` 反推出签发时间，用来做「填得太快」的判断。
 *
 * ⚠️ 这不是银弹：会跑 JS 的爬虫照样能把题算出来。它挡的是「一个 curl 就灌一百条」的
 * 脚本。真正的护栏是 `guard.ts` 里的限流 + 同文去重 + 蜜罐，以及后台的一键隐藏。
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { readUserSessionConfig } from '../users/session.js';

/** 题目有效期：2 分钟。够用户读完一段回复再提交，又短到难以囤积。 */
const TTL_MS = 2 * 60 * 1000;
/**
 * 搜索空间上界。平均要算 `MAX_NUMBER / 2` 次。
 *
 * 实测（本机 Chrome、纯 JS 实现）：15 万约 0.1 秒，50 万约 0.25~0.4 秒；手机慢 2~3 倍。
 * 取 50 万是在「用户几乎无感」与「脚本每次都要真的烧 CPU」之间选的点——比 ALTCHA 默认的
 * 100 万温和，比原来 15 万更值得让爬虫付出代价。
 */
const MAX_NUMBER = 500_000;
/** 签发后至少过这么久才收：题刚出来就提交的，一定是脚本。 */
const MIN_ELAPSED_MS = 600;
/** 已用 nonce 的内存上限，超了按过期时间淘汰最旧的。 */
const MAX_USED = 5000;

export interface Puzzle {
  algorithm: 'SHA-256';
  /** 目标哈希（十六进制）。客户端要找一个 number 使 `sha256(salt + number)` 等于它。 */
  challenge: string;
  /** 带 `?expires=…&id=…` 的随机串，签进签名里，不可篡改。 */
  salt: string;
  /** HMAC(SHA-256)，覆盖 algorithm / challenge / salt / maxnumber。 */
  signature: string;
  maxnumber: number;
}

export interface Challenge extends Puzzle {
  expiresAt: string;
  minElapsedMs: number;
}

/** 客户端交回来的东西：原题 + 找到的 number（`took` 只用于展示，不参与校验）。 */
export interface Solution extends Puzzle {
  number: number;
  took?: number;
}

export type CaptchaFailureCode =
  | 'captcha_missing'
  | 'captcha_expired'
  | 'captcha_failed'
  | 'too_fast';

export type CaptchaResult =
  | { ok: true }
  | { ok: false; code: CaptchaFailureCode; message: string };

function fail(code: CaptchaFailureCode, message: string): CaptchaResult {
  return { ok: false, code, message };
}

/** nonce → 过期时间。只用来挡重放，不存答案。 */
const used = new Map<string, number>();

function sweep(now: number): void {
  for (const [id, exp] of used) {
    if (exp <= now) used.delete(id);
  }
  if (used.size <= MAX_USED) return;
  const ordered = [...used.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id] of ordered.slice(0, used.size - MAX_USED)) used.delete(id);
}

/** 定时清扫：不 `unref()` 的话测试进程与 CLI 会一直挂着不退出。 */
const sweeper = setInterval(() => sweep(Date.now()), 60_000);
sweeper.unref();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sign(secret: string, puzzle: Omit<Puzzle, 'signature'>): string {
  // 字段顺序写死在这里：出题与验题共用同一个函数，不会改一处漏一处。
  const payload = `${puzzle.algorithm}|${puzzle.challenge}|${puzzle.salt}|${puzzle.maxnumber}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readSalt(salt: string): { expires: number; id: string } | null {
  const [, query] = salt.split('?');
  if (!query) return null;
  const params = new URLSearchParams(query);
  const expires = Number.parseInt(params.get('expires') ?? '', 10);
  const id = params.get('id') ?? '';
  if (!Number.isFinite(expires) || !id) return null;
  return { expires, id };
}

/**
 * 出一道题。
 *
 * `number` 由服务端随机选，`challenge` 是它的哈希——所以客户端只能暴力找。
 * 注意别把 `number` 放进任何返回给客户端的地方。
 */
export async function issueChallenge(): Promise<Challenge> {
  const config = await readUserSessionConfig();
  const now = Date.now();
  sweep(now);

  const expires = now + TTL_MS;
  const salt = `${randomBytes(12).toString('hex')}?expires=${expires}&id=${randomBytes(8).toString('hex')}`;
  const number = randomInt(0, MAX_NUMBER + 1);
  const base: Omit<Puzzle, 'signature'> = {
    algorithm: 'SHA-256',
    challenge: sha256Hex(`${salt}${number}`),
    salt,
    maxnumber: MAX_NUMBER,
  };

  return {
    ...base,
    signature: sign(config.secret, base),
    expiresAt: new Date(expires).toISOString(),
    minElapsedMs: MIN_ELAPSED_MS,
  };
}

function asSolution(input: unknown): Solution | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Record<string, unknown>;
  if (
    value.algorithm !== 'SHA-256' ||
    typeof value.challenge !== 'string' ||
    typeof value.salt !== 'string' ||
    typeof value.signature !== 'string' ||
    typeof value.maxnumber !== 'number' ||
    typeof value.number !== 'number'
  ) {
    return null;
  }
  if (!Number.isInteger(value.number) || value.number < 0 || value.number > value.maxnumber) {
    return null;
  }
  return {
    algorithm: 'SHA-256',
    challenge: value.challenge,
    salt: value.salt,
    signature: value.signature,
    maxnumber: value.maxnumber,
    number: value.number,
    took: typeof value.took === 'number' ? value.took : undefined,
  };
}

/**
 * 验题并**一次性消费**。
 *
 * 顺序固定：形状 → 过期 → 签名 → 是否已用过 → 是否填得太快 → 哈希是否对上。
 * 哈希放最后：前面的检查都是常数开销，没必要为一个明显过期的题去算哈希。
 */
export async function consumeChallenge(input: unknown): Promise<CaptchaResult> {
  const solution = asSolution(input);
  if (!solution) return fail('captcha_missing', '请先完成人机验证。');

  const salt = readSalt(solution.salt);
  if (!salt) return fail('captcha_missing', '请先完成人机验证。');

  const now = Date.now();
  if (salt.expires <= now) return fail('captcha_expired', '验证过期了，刷新一下再提交。');

  const config = await readUserSessionConfig();
  const expected = sign(config.secret, solution);
  if (!equalHex(solution.signature, expected)) {
    return fail('captcha_failed', '验证信息对不上，刷新一下再试。');
  }

  if (used.has(salt.id)) {
    return fail('captcha_expired', '这道题已经用过了，刷新一下再提交。');
  }

  // 签发时间 = 过期时间 - TTL，不需要服务端存。
  if (now - (salt.expires - TTL_MS) < MIN_ELAPSED_MS) {
    return fail('too_fast', '慢一点——验证刚出来就提交了，稍等一秒再试。');
  }

  if (!equalHex(sha256Hex(`${solution.salt}${solution.number}`), solution.challenge)) {
    return fail('captcha_failed', '验证没通过，刷新一下再试。');
  }

  // 只在「全部通过」之后才登记，失败不会消耗掉题。
  used.set(salt.id, salt.expires);
  sweep(now);
  return { ok: true };
}
