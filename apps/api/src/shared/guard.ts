/**
 * 反刷用的三件小工具：窗口限流、IP 假名化、内容去重。
 *
 * 位置：`shared/` —— 原本长在 `blog/` 下，但里面没有一行是博客领域的。博客的回复
 * 与留言板的留言要走同一套额度表，复制一份 150 行的限流实现比挪个目录危险得多。
 *
 * **为什么不引 `@fastify/rate-limit`**：全站四个模块都是手写等价实现（登录 8 次 /
 * 注册 5 次 / 管理员登录 5 次，各一份内存 Map），新增一个插件会让「限流到底在哪一层」
 * 出现两套答案。这里只是把 `routes/auth.ts` 里那段复制出来做成工厂，**没有去改它**：
 * 登录限流在跑，为了复用二十行去动生产代码不值得。
 *
 * 所有计数都在**单进程内存**里：重启即清零，多进程各算各的。这是「个人站点 + 零依赖」
 * 的自觉取舍，不是疏忽。
 */

import { createHash, createHmac } from 'node:crypto';

import { readUserSessionConfig } from '../users/session.js';

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

/**
 * 各场景的额度。
 *
 * 游客比登录用户严得多：登录用户至少有一个可追溯的身份，游客只有 IP。游客同时受
 * 「10 分钟 5 条」和「24 小时 30 条」两个窗口约束——短窗口挡连发，长窗口挡「每 11 分钟
 * 来一次」的慢性灌水。
 */
export const LIMITS = {
  captcha: { max: 40, windowMs: TEN_MINUTES },
  // 8 条而不是 5 条：本站的游客多半是朋友，正常讨论里连回三四条很常见；
  // 真正的灌水靠下面的 24 小时窗口和内容去重挡。
  guestReplyShort: { max: 8, windowMs: TEN_MINUTES },
  guestReplyLong: { max: 40, windowMs: ONE_DAY },
  userReply: { max: 20, windowMs: TEN_MINUTES },
  /** 登录用户的 IP 兜底：一个号也不该在 10 分钟里刷 30 条。 */
  ipReply: { max: 30, windowMs: TEN_MINUTES },
  vote: { max: 60, windowMs: TEN_MINUTES },

  /*
   * 留言板。比博客回复略紧一档：留言板是「一条一条留」的场景，不像帖内回复那样
   * 一来一回连着说话；而且它允许带图，单条的信息量更大。
   */
  messageGuestShort: { max: 6, windowMs: TEN_MINUTES },
  messageGuestLong: { max: 30, windowMs: ONE_DAY },
  messageUser: { max: 15, windowMs: TEN_MINUTES },
  /** 留言的 IP 兜底：登录用户换号也刷不过这个桶。 */
  messageIp: { max: 25, windowMs: TEN_MINUTES },

  /*
   * 图片上传。**上传与发布分开计数**：一次留言可能连传四张，按「条」算会把正常
   * 用户锁死。孤儿图不回收（与博客一致），所以额度就是磁盘的闸门。
   */
  mediaGuest: { max: 8, windowMs: TEN_MINUTES },
  mediaUser: { max: 30, windowMs: TEN_MINUTES },
} as const;

export interface LimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface Limiter {
  consume(key: string): LimitVerdict;
  reset(key: string): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 固定窗口限流。
 *
 * 与 `routes/auth.ts` 的实现同构：窗口从第一次请求开始算，不做滑动窗口——个人站点的
 * 量级不值得为「边界处可能放过一倍」写更复杂的结构。
 */
export function createLimiter(max: number, windowMs: number): Limiter {
  const buckets = new Map<string, Bucket>();

  const purge = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return {
    consume(key: string): LimitVerdict {
      const now = Date.now();
      if (buckets.size > 2000) purge(now);

      const found = buckets.get(key);
      if (!found || found.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (found.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((found.resetAt - now) / 1000)),
        };
      }
      found.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

/* ---------------------------------------------------------------------------
   IP 假名化
--------------------------------------------------------------------------- */

let secretPromise: Promise<string> | null = null;

function secret(): Promise<string> {
  secretPromise ??= readUserSessionConfig().then((config) => config.secret);
  return secretPromise;
}

/**
 * IP → 16 位十六进制假名。
 *
 * 用途只有两个：给限流表当键、给后台看出「这几条是同一个来源刷的」。原始 IP 不进
 * 数据文件，也不额外写日志（`request.ip` 本来就在 Fastify 的访问日志里）。
 */
export async function hashActor(value: string): Promise<string> {
  const key = await secret();
  return createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
}

/** 正文指纹：判断「同一个人连续发同一段话」。 */
export function contentFingerprint(body: string): string {
  const normalized = body.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/* ---------------------------------------------------------------------------
   内容去重
--------------------------------------------------------------------------- */

export interface DuplicateGuard {
  /** 返回 `true` 表示「窗口内已经出现过同样的内容」，调用方应当拒绝。 */
  hit(key: string): boolean;
}

export function createDuplicateGuard(windowMs: number, capacity = 2000): DuplicateGuard {
  const seen = new Map<string, number>();

  return {
    hit(key: string): boolean {
      const now = Date.now();
      for (const [item, at] of seen) {
        if (now - at >= windowMs) seen.delete(item);
      }
      const found = seen.get(key);
      if (found !== undefined && now - found < windowMs) return true;
      seen.set(key, now);
      if (seen.size > capacity) {
        const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]);
        for (const [item] of ordered.slice(0, seen.size - capacity)) seen.delete(item);
      }
      return false;
    },
  };
}
