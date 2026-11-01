/**
 * 管理后台的「账户」与「徽章」接口。
 *
 * 权限分两层，缺一不可：
 *
 *   · **路由级**（`admin/guard.ts`）：这个请求能不能进这个接口。徽章相关与内容生产
 *     写在这里的 `OWNER_ONLY` 表里；
 *   · **数据级**（本文件 + `users/store.ts`）：这次操作对**这个目标**合不合法
 *     （不能操作自己、管理员不能碰站长、至少留一个站长）。这些判断必须在
 *     `store.mutate()` 回调里做，因为它要看全表——见 `assertCanSetRole` 的说明。
 *
 * 本文件所有接口都返回 `AdminAccount`（唯一的后台账号视图）。它**不复用**
 * `toPublicUser()`：那个形状故意不含 `status` / `email` 的归属信息，而后台恰恰要这些。
 * 反过来它也**绝不含** `passwordHash` 与 `*Key`——手写字段，不 spread 整条记录。
 */

import type { FastifyInstance } from 'fastify';

import { currentActor } from '../admin/guard.js';
import { accountCaps, assertOwner, type AccountCaps } from '../admin/permissions.js';
import {
  createBadge,
  grantBadge,
  grantCounts,
  grantedViewsOfMany,
  listCatalog,
  revokeBadge,
  setBadgeArchived,
  updateBadge,
  type GrantedBadgeDef,
} from '../users/badges-store.js';
import type { GrantedBadgeView } from '../users/granted-badges.js';
import {
  activeBan,
  activeMute,
  isMuted,
  isSanctionDays,
  normalizeModeration,
  SANCTION_REASON_MAX,
  sanctionUntil,
  type Sanction,
} from '../users/moderation.js';
import { listUsers, setBan, setMute, setRole } from '../users/store.js';
import type { Role, UserRecord } from '../users/types.js';
import { assertRole, UserError } from '../users/validate.js';
import { failUser } from './error.js';

/** 后台看到的处罚：多一个 `active`，让前端不用自己比时间。 */
export interface AdminSanctionView extends Sanction {
  active: boolean;
}

export interface AdminAccount {
  id: string;
  username: string;
  nickname: string;
  email: string;
  role: Role;
  /** `status === 'disabled'`（可能是 CLI 停用，也可能是永久封禁）。 */
  legacyDisabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  ban: AdminSanctionView | null;
  mute: AdminSanctionView | null;
  grantedBadges: GrantedBadgeView[];
  /** 由服务端算好的「能对他做什么」，前端只负责禁用按钮。 */
  can: AccountCaps;
}

export interface BadgeWithCount extends GrantedBadgeDef {
  grantCount: number;
}

const ROLE_WEIGHT: Record<Role, number> = { owner: 0, admin: 1, user: 2 };
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function sanctionView(
  raw: Sanction | null | undefined,
  active: Sanction | null,
): AdminSanctionView | null {
  if (!raw) return null;
  return { ...raw, active: active !== null };
}

function toAdminAccount(
  record: UserRecord,
  actor: ReturnType<typeof currentActor>,
  badges: GrantedBadgeView[],
  now: number,
): AdminAccount {
  const moderation = record.moderation ?? normalizeModeration(undefined);
  return {
    id: record.id,
    username: record.username,
    nickname: record.nickname,
    email: record.email,
    role: record.role,
    legacyDisabled: record.status === 'disabled',
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
    ban: sanctionView(moderation.ban, activeBan(record, now)),
    mute: sanctionView(moderation.mute, activeMute(record, now)),
    grantedBadges: badges,
    can: accountCaps(actor, record),
  };
}

/* ---------------------------------------------------------------------------
   查询参数
--------------------------------------------------------------------------- */

type StateFilter = 'all' | 'active' | 'banned' | 'muted' | 'disabled';

interface ListQuery {
  q: string;
  role: Role | 'all';
  state: StateFilter;
  page: number;
  size: number;
}

function readListQuery(raw: unknown): ListQuery {
  const value = (raw ?? {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === 'string' ? value[key].trim() : '');

  const roleText = text('role');
  const stateText = text('state') || 'all';
  const states: StateFilter[] = ['all', 'active', 'banned', 'muted', 'disabled'];
  if (!states.includes(stateText as StateFilter)) {
    throw new UserError(400, 'invalid_query', 'state 只能是 all / active / banned / muted / disabled。');
  }
  if (roleText && roleText !== 'all' && !['user', 'admin', 'owner'].includes(roleText)) {
    throw new UserError(400, 'invalid_query', 'role 只能是 all / user / admin / owner。');
  }

  const page = Math.max(1, Number.parseInt(text('page'), 10) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(text('size'), 10) || DEFAULT_PAGE_SIZE));

  return {
    q: text('q'),
    role: (roleText || 'all') as Role | 'all',
    state: stateText as StateFilter,
    page,
    size,
  };
}

/**
 * 关键词匹配。
 *
 * 比对的是 `*Key`（已 NFKC + 小写），所以「ＭnO4」也能搜到「mno4_」——
 * 用原值 `includes` 会让全角输入永远搜不到。
 */
function matchesQuery(record: UserRecord, key: string): boolean {
  if (!key) return true;
  return (
    record.usernameKey.includes(key) ||
    record.nicknameKey.includes(key) ||
    record.emailKey.includes(key)
  );
}

function matchesState(record: UserRecord, state: StateFilter, now: number): boolean {
  if (state === 'all') return true;
  if (state === 'disabled') return record.status === 'disabled';
  if (state === 'banned') return activeBan(record, now) !== null || record.status === 'disabled';
  if (state === 'muted') return isMuted(record, now);
  // active = 能正常用，且没被禁言（禁言的人「能用但不能说」，单独一档更符合直觉）
  return activeBan(record, now) === null && record.status === 'active' && !isMuted(record, now);
}

function readId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) throw new UserError(400, 'invalid_body', '缺少账号 id。');
  return id;
}

function readDays(raw: unknown): 1 | 3 | 7 | 30 | 0 {
  const days = typeof raw === 'number' ? raw : Number(raw);
  if (!isSanctionDays(days)) {
    throw new UserError(400, 'invalid_days', '时长只能是 1 / 3 / 7 / 30 天，或 0（永久）。');
  }
  return days;
}

function readReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.trim()).slice(0, SANCTION_REASON_MAX).join('');
}

/** 审计：写进后端日志，后台「控制台」能直接看到。 */
function audit(
  app: FastifyInstance,
  actor: ReturnType<typeof currentActor>,
  action: string,
  detail: Record<string, unknown>,
): void {
  app.log.info({ moderation: action, by: actor.name, via: actor.source, ...detail }, 'moderation');
}

export async function adminAccountRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------------------------------------------------------
     账号
  ------------------------------------------------------------------------- */

  app.get('/admin/accounts', async (request, reply) => {
    const actor = currentActor(request);
    try {
      const query = readListQuery(request.query);
      const now = Date.now();
      const key = query.q.normalize('NFKC').toLowerCase();

      const all = await listUsers();
      const counts = {
        total: all.length,
        owners: all.filter((item) => item.role === 'owner').length,
        admins: all.filter((item) => item.role === 'admin').length,
        banned: all.filter((item) => activeBan(item, now) !== null || item.status === 'disabled').length,
        muted: all.filter((item) => isMuted(item, now)).length,
      };

      const filtered = all
        .filter((item) => matchesQuery(item, key))
        .filter((item) => query.role === 'all' || item.role === query.role)
        .filter((item) => matchesState(item, query.state, now))
        .sort(
          (a, b) =>
            ROLE_WEIGHT[a.role] - ROLE_WEIGHT[b.role] || a.createdAt.localeCompare(b.createdAt),
        );

      const start = (query.page - 1) * query.size;
      const pageItems = filtered.slice(start, start + query.size);
      const badges = await grantedViewsOfMany(pageItems.map((item) => item.id));

      return reply.send({
        accounts: pageItems.map((item) => toAdminAccount(item, actor, badges.get(item.id) ?? [], now)),
        total: filtered.length,
        page: query.page,
        size: query.size,
        counts,
      });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.get('/admin/accounts/:id', async (request, reply) => {
    const actor = currentActor(request);
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const all = await listUsers();
      const record = all.find((item) => item.id === id);
      if (!record) throw new UserError(404, 'account_not_found', '这个账号不存在。');
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/admin/accounts/:id/role', async (request, reply) => {
    const actor = currentActor(request);
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const role = assertRole(typeof raw.role === 'string' ? raw.role : '');

      const record = await setRole(id, role, actor);
      audit(app, actor, 'set_role', { target: record.username, role });
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  /** 封禁 / 解封共用一个入口：`days` 缺省或为负表示解封，代码里只留一套权限判定。 */
  app.post('/admin/accounts/:id/ban', async (request, reply) => {
    const actor = currentActor(request);
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const lift = raw.lift === true;
      const sanction: Sanction | null = lift
        ? null
        : {
            until: sanctionUntil(readDays(raw.days)),
            reason: readReason(raw.reason),
            by: actor.name,
            bySource: actor.source,
            at: new Date().toISOString(),
          };

      const record = await setBan(id, sanction, actor);
      audit(app, actor, lift ? 'unban' : 'ban', {
        target: record.username,
        until: sanction?.until ?? null,
        reason: sanction?.reason ?? '',
      });
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/admin/accounts/:id/mute', async (request, reply) => {
    const actor = currentActor(request);
    try {
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const lift = raw.lift === true;
      const sanction: Sanction | null = lift
        ? null
        : {
            until: sanctionUntil(readDays(raw.days)),
            reason: readReason(raw.reason),
            by: actor.name,
            bySource: actor.source,
            at: new Date().toISOString(),
          };

      const record = await setMute(id, sanction, actor);
      audit(app, actor, lift ? 'unmute' : 'mute', {
        target: record.username,
        until: sanction?.until ?? null,
        reason: sanction?.reason ?? '',
      });
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  /* -------------------------------------------------------------------------
     徽章目录（owner only；guard 里也有同样的限制，这里是第二道）
  ------------------------------------------------------------------------- */

  app.get('/admin/badges', async (request, reply) => {
    // 目录本身对管理员开放（要显示「他有哪些徽章」），写操作才限 owner。
    currentActor(request);
    try {
      const [catalog, counts] = await Promise.all([listCatalog(), grantCounts()]);
      const withCount = (item: GrantedBadgeDef): BadgeWithCount => ({
        ...item,
        grantCount: counts.get(item.id) ?? 0,
      });
      return reply.send({
        badges: catalog.badges.map(withCount),
        archived: catalog.archived.map(withCount),
      });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/admin/badges', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const badge = await createBadge(raw, actor.name);
      audit(app, actor, 'badge_create', { badge: badge.label });
      return reply.code(201).send({ badge: { ...badge, grantCount: 0 } });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.put('/admin/badges/:id', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const badge = await updateBadge(id, raw);
      audit(app, actor, 'badge_update', { badge: badge.label });
      return reply.send({ badge });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  /** 下架（软删）。已授予的人**不会**被收回，前端要把这句说清楚。 */
  app.delete('/admin/badges/:id', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const id = readId((request.params as { id?: unknown }).id);
      const result = await setBadgeArchived(id, true);
      audit(app, actor, 'badge_archive', { badge: result.badge.label });
      return reply.send({ badge: result.badge, affectedGrants: result.affectedGrants });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/admin/badges/:id/restore', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const id = readId((request.params as { id?: unknown }).id);
      const result = await setBadgeArchived(id, false);
      audit(app, actor, 'badge_restore', { badge: result.badge.label });
      return reply.send({ badge: result.badge, affectedGrants: result.affectedGrants });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.post('/admin/accounts/:id/badges', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const id = readId((request.params as { id?: unknown }).id);
      const raw = (request.body ?? {}) as Record<string, unknown>;
      const badgeId = typeof raw.badgeId === 'string' ? raw.badgeId.trim() : '';
      if (!badgeId) throw new UserError(400, 'invalid_body', '缺少 badgeId。');

      await grantBadge(id, badgeId, actor.name);
      audit(app, actor, 'badge_grant', { target: id, badge: badgeId });

      const all = await listUsers();
      const record = all.find((item) => item.id === id);
      if (!record) throw new UserError(404, 'account_not_found', '这个账号不存在。');
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });

  app.delete('/admin/accounts/:id/badges/:badgeId', async (request, reply) => {
    const actor = currentActor(request);
    try {
      assertOwner(actor);
      const id = readId((request.params as { id?: unknown }).id);
      const params = request.params as { badgeId?: unknown };
      const badgeId = typeof params.badgeId === 'string' ? params.badgeId.trim() : '';
      if (!badgeId) throw new UserError(400, 'invalid_body', '缺少 badgeId。');

      await revokeBadge(id, badgeId, actor.name);
      audit(app, actor, 'badge_revoke', { target: id, badge: badgeId });

      const all = await listUsers();
      const record = all.find((item) => item.id === id);
      if (!record) throw new UserError(404, 'account_not_found', '这个账号不存在。');
      const badges = await grantedViewsOfMany([id]);
      return reply.send({ account: toAdminAccount(record, actor, badges.get(id) ?? [], Date.now()) });
    } catch (error) {
      return failUser(app, reply, error);
    }
  });
}
