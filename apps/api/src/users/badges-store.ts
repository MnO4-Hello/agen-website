/**
 * 「授予徽章」的持久化层：`apps/api/data/badges.json`。
 *
 * 与账号（`users/store.ts`）同一套基础设施与纪律：整份重写、原子写、串行队列、
 * 解析失败不重置。三条账号特有的规矩在这里同样成立：
 *
 *   · **唯一性检查必须在 `mutate()` 内**。两个管理员同时给同一个人发同一枚徽章，
 *     放到外面「先查再写」会双双通过。
 *   · **下架是软删**（`archivedAt`）。硬删会让「他凭什么有这枚徽章」变成无解，
 *     而且已授予的人会突然掉一枚徽章——下架只是不再出现在可授予列表里。
 *   · **撤销也是软记录**（`revokedAt` / `revokedBy`）。审计比省几行 JSON 重要。
 *
 * 与 `profile.badges`（用户自建徽章）**零交集**：用户 PATCH 资料永远碰不到这个文件。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../data/json-store.js';
import type { GrantedBadgeView } from './granted-badges.js';
import { normalizeHex, PROFILE_LIMITS } from './profile-types.js';
import { UserError } from './validate.js';

/** 同 `users/store.ts`：`src|dist` 往上两跳到 `apps/api`。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');

/** hover 提示的长度上限。 */
const HINT_MAX = 40;
const DEFAULT_HINT = '由站长授予';

export interface GrantedBadgeDef {
  /** `g-` + 8 位 36 进制。服务端生成。 */
  id: string;
  label: string;
  /** `#rrggbb`。 */
  color: string;
  emoji: string;
  hint: string;
  /** 升序排列用；新建时取当前最大值 +1。 */
  order: number;
  createdAt: string;
  createdBy: string;
  /** 非 null = 已下架（不再可授予，但已授予的仍然显示）。 */
  archivedAt: string | null;
}

export interface BadgeGrant {
  /** `gr-` + 8 位。 */
  id: string;
  userId: string;
  badgeId: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface BadgesState {
  version: 1;
  updatedAt: string;
  badges: GrantedBadgeDef[];
  grants: BadgeGrant[];
}

function storeError(message: string): Error {
  return new UserError(500, 'badge_store_error', message);
}

const stamp = (): string => new Date().toISOString();

function createEmpty(): BadgesState {
  return { version: 1, updatedAt: stamp(), badges: [], grants: [] };
}

/**
 * 结构校验：坏文件抛错让人去修，绝不静默重置（重置等于把所有人被授予的徽章删掉）。
 *
 * 逐条检查而不是 `as BadgesState` 硬转：带着一条残缺记录跑下去，报错会出现在
 * 几百行之外的渲染代码里。
 */
function parseState(raw: unknown): BadgesState {
  if (typeof raw !== 'object' || raw === null) throw storeError('badges.json 的结构不对。');
  const value = raw as Partial<BadgesState>;
  if (!Array.isArray(value.badges) || !Array.isArray(value.grants)) {
    throw storeError('badges.json 缺少 badges / grants 数组。');
  }
  const defsOk = value.badges.every(
    (item) => typeof item === 'object' && item !== null && typeof item.id === 'string',
  );
  const grantsOk = value.grants.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.userId === 'string' &&
      typeof item.badgeId === 'string',
  );
  if (!defsOk || !grantsOk) {
    throw storeError('badges.json 里有缺少 id / userId / badgeId 的记录，请先修好。');
  }
  return { version: 1, updatedAt: value.updatedAt ?? stamp(), badges: value.badges, grants: value.grants };
}

const store = createJsonStore<BadgesState>({
  dir: DATA_DIR,
  filePath: path.join(DATA_DIR, 'badges.json'),
  createEmpty,
  parse: parseState,
  fail: storeError,
});

/** 给后台显示「数据存在哪」用。 */
export const badgesFile = store.filePath;

function shortId(prefix: 'g' | 'gr'): string {
  // 8 位 36 进制 ≈ 2.8 万亿种，够用；不需要密码学强度（与 profile-validate 的 newLocalId 一致）。
  return `${prefix}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

/** 比较用的键：NFKC + 去空白 + 小写（与自建徽章的 `badgeKey` 同一规则）。 */
function badgeKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/* ---------------------------------------------------------------------------
   校验
--------------------------------------------------------------------------- */

export interface BadgeInput {
  label?: unknown;
  color?: unknown;
  emoji?: unknown;
  hint?: unknown;
}

interface ParsedBadge {
  label?: string;
  color?: string;
  emoji?: string;
  hint?: string;
}

function invalid(message: string): never {
  throw new UserError(400, 'invalid_badge', message);
}

/**
 * 只校验**提交了的**字段（编辑时可以只改颜色）。
 *
 * 注意这里**不查** `BADGE_RESERVED`：那套保留字挡的是「用户自封官方认证」，
 * 而站长本来就该有能力发一枚叫「官方认证」的徽章。
 */
function parseBadgeInput(input: BadgeInput): ParsedBadge {
  const out: ParsedBadge = {};

  if (input.label !== undefined) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label) invalid('徽章要有名字。');
    if (Array.from(label).length > PROFILE_LIMITS.badgeLabel) {
      invalid(`徽章名称最多 ${PROFILE_LIMITS.badgeLabel} 个字。`);
    }
    if (/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/.test(label)) {
      invalid('徽章名称里有不能使用的字符。');
    }
    out.label = label;
  }

  if (input.color !== undefined) {
    const color = normalizeHex(input.color);
    if (!color) invalid('徽章颜色要写成 #rrggbb。');
    out.color = color;
  }

  if (input.emoji !== undefined) {
    const emoji = typeof input.emoji === 'string' ? input.emoji.trim() : '';
    if (Array.from(emoji).length > PROFILE_LIMITS.badgeEmoji) {
      invalid(`徽章图标最多 ${PROFILE_LIMITS.badgeEmoji} 个字符。`);
    }
    out.emoji = emoji;
  }

  if (input.hint !== undefined) {
    const hint = typeof input.hint === 'string' ? input.hint.trim() : '';
    if (Array.from(hint).length > HINT_MAX) invalid(`提示语最多 ${HINT_MAX} 个字。`);
    out.hint = hint;
  }

  return out;
}

/* ---------------------------------------------------------------------------
   目录读写
--------------------------------------------------------------------------- */

function sortDefs(defs: GrantedBadgeDef[]): GrantedBadgeDef[] {
  return [...defs].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export interface BadgeCatalog {
  /** 未下架，按 order 升序。 */
  badges: GrantedBadgeDef[];
  archived: GrantedBadgeDef[];
}

export async function listCatalog(): Promise<BadgeCatalog> {
  const state = await store.read();
  return {
    badges: sortDefs(state.badges.filter((item) => item.archivedAt === null)),
    archived: sortDefs(state.badges.filter((item) => item.archivedAt !== null)),
  };
}

/** 每枚徽章当前授予了多少人（已撤销的不算）。 */
export async function grantCounts(): Promise<Map<string, number>> {
  const state = await store.read();
  const counts = new Map<string, number>();
  for (const grant of state.grants) {
    if (grant.revokedAt !== null) continue;
    counts.set(grant.badgeId, (counts.get(grant.badgeId) ?? 0) + 1);
  }
  return counts;
}

export async function createBadge(input: BadgeInput, by: string): Promise<GrantedBadgeDef> {
  const parsed = parseBadgeInput(input);
  if (!parsed.label || !parsed.color) invalid('徽章要有名字和颜色。');

  return store.mutate((state) => {
    const key = badgeKey(parsed.label!);
    const clash = state.badges.some(
      (item) => item.archivedAt === null && badgeKey(item.label) === key,
    );
    if (clash) {
      throw new UserError(409, 'badge_exists', `已经有一枚叫「${parsed.label}」的徽章了。`);
    }

    const now = stamp();
    const record: GrantedBadgeDef = {
      id: shortId('g'),
      label: parsed.label!,
      color: parsed.color!,
      emoji: parsed.emoji ?? '',
      hint: parsed.hint || DEFAULT_HINT,
      order: state.badges.reduce((max, item) => Math.max(max, item.order), 0) + 1,
      createdAt: now,
      createdBy: by,
      archivedAt: null,
    };
    state.badges.push(record);
    state.updatedAt = now;
    return record;
  });
}

export async function updateBadge(id: string, input: BadgeInput): Promise<GrantedBadgeDef> {
  const parsed = parseBadgeInput(input);

  return store.mutate((state) => {
    const record = state.badges.find((item) => item.id === id);
    if (!record) throw new UserError(404, 'badge_not_found', '这枚徽章不存在（可能已经被删掉了）。');
    if (record.archivedAt !== null) {
      throw new UserError(409, 'badge_archived', '这枚徽章已下架，先恢复再改。');
    }
    if (parsed.label !== undefined) {
      const key = badgeKey(parsed.label);
      const clash = state.badges.some(
        (item) => item.id !== id && item.archivedAt === null && badgeKey(item.label) === key,
      );
      if (clash) throw new UserError(409, 'badge_exists', `已经有一枚叫「${parsed.label}」的徽章了。`);
      record.label = parsed.label;
    }
    if (parsed.color !== undefined) record.color = parsed.color;
    if (parsed.emoji !== undefined) record.emoji = parsed.emoji;
    if (parsed.hint !== undefined) record.hint = parsed.hint || DEFAULT_HINT;
    state.updatedAt = stamp();
    return record;
  });
}

export interface ArchiveResult {
  badge: GrantedBadgeDef;
  /** 已经拿到这枚徽章的人数——前端用它提示「不会收回」。 */
  affectedGrants: number;
}

/** 下架 / 恢复。下架**不动**任何授予记录。 */
export async function setBadgeArchived(id: string, archived: boolean): Promise<ArchiveResult> {
  return store.mutate((state) => {
    const record = state.badges.find((item) => item.id === id);
    if (!record) throw new UserError(404, 'badge_not_found', '这枚徽章不存在（可能已经被删掉了）。');
    record.archivedAt = archived ? stamp() : null;
    state.updatedAt = stamp();
    const affectedGrants = state.grants.filter(
      (grant) => grant.badgeId === id && grant.revokedAt === null,
    ).length;
    return { badge: record, affectedGrants };
  });
}

/* ---------------------------------------------------------------------------
   授予 / 撤销
--------------------------------------------------------------------------- */

export async function grantBadge(userId: string, badgeId: string, by: string): Promise<BadgeGrant> {
  return store.mutate((state) => {
    const def = state.badges.find((item) => item.id === badgeId);
    if (!def) throw new UserError(404, 'badge_not_found', '这枚徽章不存在（可能已经被删掉了）。');
    if (def.archivedAt !== null) throw new UserError(409, 'badge_archived', '这枚徽章已下架，先恢复再授予。');

    const existing = state.grants.find(
      (grant) => grant.userId === userId && grant.badgeId === badgeId && grant.revokedAt === null,
    );
    if (existing) throw new UserError(409, 'already_granted', '这个人已经有这枚徽章了。');

    const now = stamp();
    const record: BadgeGrant = {
      id: shortId('gr'),
      userId,
      badgeId,
      grantedBy: by,
      grantedAt: now,
      revokedAt: null,
      revokedBy: null,
    };
    state.grants.push(record);
    state.updatedAt = now;
    return record;
  });
}

export async function revokeBadge(userId: string, badgeId: string, by: string): Promise<void> {
  await store.mutate((state) => {
    const grant = state.grants.find(
      (item) => item.userId === userId && item.badgeId === badgeId && item.revokedAt === null,
    );
    if (!grant) throw new UserError(409, 'not_granted', '这个人没有这枚徽章。');
    grant.revokedAt = stamp();
    grant.revokedBy = by;
    state.updatedAt = grant.revokedAt;
  });
}

/* ---------------------------------------------------------------------------
   读取：给主页 / 个人中心 / 后台用
--------------------------------------------------------------------------- */

function toView(grant: BadgeGrant, def: GrantedBadgeDef): GrantedBadgeView {
  return {
    badgeId: def.id,
    label: def.label,
    color: def.color,
    emoji: def.emoji,
    hint: def.hint,
    grantedAt: grant.grantedAt,
    archived: def.archivedAt !== null,
  };
}

/**
 * 一个人的全部授予徽章（含已下架的目录项——徽章本身还在他身上）。
 *
 * 目录项找不到（理论上不该发生）时直接跳过：宁可少渲染一枚，也不要抛错把整页打挂。
 */
export async function grantedViewsOf(userId: string): Promise<GrantedBadgeView[]> {
  const map = await grantedViewsOfMany([userId]);
  return map.get(userId) ?? [];
}

/** 批量版：后台列表一页 20 个人，逐个查会把队列排成一条。 */
export async function grantedViewsOfMany(userIds: string[]): Promise<Map<string, GrantedBadgeView[]>> {
  const out = new Map<string, GrantedBadgeView[]>();
  if (userIds.length === 0) return out;

  const wanted = new Set(userIds);
  const state = await store.read();
  const defs = new Map(state.badges.map((item) => [item.id, item]));

  for (const id of wanted) out.set(id, []);
  for (const grant of state.grants) {
    if (grant.revokedAt !== null) continue;
    if (!wanted.has(grant.userId)) continue;
    const def = defs.get(grant.badgeId);
    if (!def) continue;
    out.get(grant.userId)!.push(toView(grant, def));
  }

  // 老徽章在前：按目录顺序排，而不是按授予时间——同一批人的徽章顺序才稳定。
  for (const views of out.values()) {
    views.sort((a, b) => {
      const left = defs.get(a.badgeId)?.order ?? 0;
      const right = defs.get(b.badgeId)?.order ?? 0;
      return left - right;
    });
  }
  return out;
}
