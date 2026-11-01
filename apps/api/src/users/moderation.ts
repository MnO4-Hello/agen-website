/**
 * 处罚（封禁 / 禁言）的判定与归一化。
 *
 * 设计的核心是**一个判定规则只写一份**：账号「能不能用」由 `isActive()` 算，
 * 「能不能发言」由 `isMuted()` 算。全站（会话、登录、公开主页、作者快照、后台列表）
 * 都调这两个函数，不要再去直读 `record.status`。
 *
 * 三条刻意的取舍：
 *
 *   1. **不写定时任务**。限期处罚只存「到期时间」，每次判定时拿 `now` 比一下；
 *      过期自然失效。代价是列表里会看到「已过期」的旧记录——那正好是审计信息，
 *      下一次处罚写入时被覆盖。
 *   2. **禁言绝不写 `status`**。写了就等于封禁（登不进来），这是最容易踩的一脚。
 *      `status` 只表达「账号本身被停用」，`moderation.ban` 表达「被谁因为什么封到哪天」。
 *   3. **脏数据往「不放人」的方向修**。`until` 解析不出来时按永久处理：悄悄解封一个
 *      本该被封的人，比多关他一天严重得多。
 */

import type { UserRecord } from './types.js';

/** 一次处罚。`until === null` 表示永久。 */
export interface Sanction {
  /** ISO 时间；`null` = 永久。 */
  until: string | null;
  /** 展示给被处罚者看的原因，可为空串。 */
  reason: string;
  /** 操作人的展示名（`.env` 管理员就是那个用户名）。 */
  by: string;
  /** 操作人是环境变量管理员还是站点账号——用于区分「站长本人」与「被授权的管理员」。 */
  bySource: 'env' | 'account';
  at: string;
}

export interface ModerationState {
  ban: Sanction | null;
  mute: Sanction | null;
}

/**
 * 后台给的时长档位（天）。`0` = 永久。
 *
 * 刻意做成固定档位而不是自由输入：一个手滑的 `36500` 等于永久封禁，而界面上
 * 只是「多打了两个 0」。服务端只认这几个值。
 */
export const SANCTION_DAYS = [1, 3, 7, 30, 0] as const;

export type SanctionDays = (typeof SANCTION_DAYS)[number];

/** 原因的长度上限（按码点算）。够写一句话，又不至于把提示条撑爆。 */
export const SANCTION_REASON_MAX = 100;

export function isSanctionDays(value: unknown): value is SanctionDays {
  return typeof value === 'number' && (SANCTION_DAYS as readonly number[]).includes(value);
}

/** 没被处罚过的账号用这份共享空值；调用方不要改它。 */
export function emptyModeration(): ModerationState {
  return { ban: null, mute: null };
}

function readText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, max).join('');
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * 尽力把磁盘上的脏数据修成合法形状。
 *
 * 只在 `store.parseState()` 里调用，**不落盘**（与 `profile` 的处理方式一致）：
 * `read()` 不该产生写入，否则每次启动都会冲掉 `.bak`。
 */
export function normalizeSanction(raw: unknown): Sanction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  // 没有 at 的记录当作不存在：处罚必须能回答「谁在什么时候做的」。
  const at = readIso(value.at);
  if (!at) return null;

  return {
    until: readIso(value.until),
    reason: readText(value.reason, SANCTION_REASON_MAX),
    by: readText(value.by, 64) || '未知',
    bySource: value.bySource === 'env' ? 'env' : 'account',
    at,
  };
}

export function normalizeModeration(raw: unknown): ModerationState {
  if (typeof raw !== 'object' || raw === null) return emptyModeration();
  const value = raw as Record<string, unknown>;
  return { ban: normalizeSanction(value.ban), mute: normalizeSanction(value.mute) };
}

/**
 * 还在生效的那条处罚；过期返回 `null`。
 *
 * `until` 解析不出来时返回原记录（＝当永久处理），理由见文件头第 3 条。
 */
export function activeSanction(
  sanction: Sanction | null | undefined,
  now: number,
): Sanction | null {
  if (!sanction) return null;
  if (sanction.until === null) return sanction;
  const until = Date.parse(sanction.until);
  if (!Number.isFinite(until)) return sanction;
  return until > now ? sanction : null;
}

type Moderatable = Pick<UserRecord, 'status'> & { moderation?: ModerationState };

export function activeBan(record: Moderatable, now: number = Date.now()): Sanction | null {
  return activeSanction(record.moderation?.ban, now);
}

export function activeMute(record: Moderatable, now: number = Date.now()): Sanction | null {
  return activeSanction(record.moderation?.mute, now);
}

/** 封禁 = 永久停用标记（`status`）或还有效的限期封禁。 */
export function isBanned(record: Moderatable, now: number = Date.now()): boolean {
  return record.status === 'disabled' || activeBan(record, now) !== null;
}

/** 能不能用这个账号：能登录、会话有效、公开主页可见、作者不作「已注销」。 */
export function isActive(record: Moderatable, now: number = Date.now()): boolean {
  return record.status === 'active' && activeBan(record, now) === null;
}

/** 能不能发言（发帖 / 回复 / 留言 / 留言图片）。被禁言的人仍然能登录、能看。 */
export function isMuted(record: Moderatable, now: number = Date.now()): boolean {
  return activeMute(record, now) !== null;
}

/** 把「N 天」算成到期时间；`0` 天 = 永久（`null`）。 */
export function sanctionUntil(days: SanctionDays, now: number = Date.now()): string | null {
  if (days === 0) return null;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 给用户看的到期文案。
 *
 * 用**服务器本地时区**格式化：前台与后台拿到的都是同一串，省掉两边各自格式化
 * 导致「后台说 11-03、前台说 11-02」的经典事故。
 */
export function untilLabel(until: string | null): string {
  if (!until) return '永久';
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return '永久';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `封禁至 2026-11-03 14:00` / `永久封禁`。`verb` 用「封禁」或「禁言」。 */
export function sanctionLabel(verb: string, sanction: Sanction): string {
  return sanction.until === null ? `永久${verb}` : `${verb}至 ${untilLabel(sanction.until)}`;
}

/**
 * 给「本人」看的禁言态。没被禁言返回 `null`（响应里干脆不出现这个字段）。
 *
 * 只下发「被禁言」——封禁的人根本登录不了，没必要再塞一个字段。
 */
export interface ModerationView {
  muted: true;
  mutedUntil: string | null;
  /** 排好版的中文（`至 2026-11-03 14:00` / `永久`），前端直接拼进提示条。 */
  mutedLabel: string;
  mutedReason: string;
}

export function moderationOf(record: Moderatable, now: number = Date.now()): ModerationView | null {
  const mute = activeMute(record, now);
  if (!mute) return null;
  return {
    muted: true,
    mutedUntil: mute.until,
    mutedLabel: untilLabel(mute.until),
    mutedReason: mute.reason,
  };
}

/**
 * 被禁言时统一的拒绝话术（留言板、博客回复、图片上传共用）。
 *
 * 三处各写一份的话，迟早出现「留言板说禁言到 11-03、博客说永久禁言」这种事故。
 */
export function mutedMessage(sanction: Sanction): string {
  const reason = sanction.reason ? `（原因：${sanction.reason}）` : '';
  return sanction.until === null
    ? `你已被永久禁言${reason}，暂时不能发言。`
    : `你已被禁言至 ${untilLabel(sanction.until)}${reason}，暂时不能发言。`;
}
