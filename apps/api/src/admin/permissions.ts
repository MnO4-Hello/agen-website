/**
 * 三级权限（owner / admin / user）的判定规则，**只写一份**。
 *
 * 为什么要单独一个文件：这套规则同时被三个地方需要——
 *
 *   · `admin/guard.ts`：这个请求能不能碰这个路由（owner-only 的写接口）；
 *   · `users/store.ts`：改角色 / 处罚前的不变式（必须在 `mutate()` 回调里跑，
 *     否则两个管理员同时降级两个 owner，会双双通过检查，把站点降成 0 个 owner）；
 *   · `routes/admin-accounts.ts`：返回给后台的 `can.*`，前端据此禁用按钮。
 *
 * 前端**不重写**这套矩阵（它只负责 `disabled` + `title` 说明原因），否则两处
 * 迟早会不一致——而不一致的方向一定是「界面以为不能点、接口其实放行」。
 *
 * 身份来源只有一种：users.json 里的 `owner` / `admin` 账号（`source: 'account'`）。
 * （2026-11-04 之前还有 `.env` 的 `ADMIN_USER`，它在 users.json 里没有记录、删不掉，
 *  已按要求整体移除。`source: 'env'` 现在只剩 DEV 预览 mock 在用，真实登录不会产生。）
 */

import type { Role, UserRecord } from '../users/types.js';
import { UserError } from '../users/validate.js';

export type ActorRole = 'owner' | 'admin';

export interface AdminActor {
  /** 展示名 / 审计用（账号的昵称，没有就退回用户名）。 */
  name: string;
  role: ActorRole;
  /** 对应的 `UserRecord.id`。 */
  userId: string | null;
  /** 真实登录恒为 `'account'`；`'env'` 只为 DEV 预览 mock 保留。 */
  source: 'env' | 'account';
}

export function isOwner(actor: AdminActor): boolean {
  return actor.role === 'owner';
}

/* ---------------------------------------------------------------------------
   后台列表里的 can.*（前端只用来禁用按钮）
--------------------------------------------------------------------------- */

export interface AccountCaps {
  /** 能不能改这个人的角色。 */
  role: boolean;
  ban: boolean;
  mute: boolean;
  /** 能不能授予徽章（只有 owner 能）。 */
  grantBadge: boolean;
  /** 能不能把这个人提为 owner（只有 owner 能）。 */
  grantOwner: boolean;
  revokeBadge: boolean;
}

/**
 * 目标账号能被当前操作者做什么。
 *
 * 注意「能在界面上点」和「接口一定放行」是两件事：这里只做**无状态**的粗判，
 * 真正的把关在 `assert*` 里（它们还会检查「至少留一个 owner」这种需要看全表的状态）。
 */
export function accountCaps(actor: AdminActor, target: Pick<UserRecord, 'id' | 'role'>): AccountCaps {
  const self = actor.userId !== null && actor.userId === target.id;
  // 管理员不能碰 owner；owner 也不能操作自己（避免手滑把自己锁在外面）。
  const canTouch = !self && (actor.role === 'owner' || target.role !== 'owner');
  const owner = actor.role === 'owner';

  return {
    role: canTouch,
    ban: canTouch,
    mute: canTouch,
    grantBadge: owner,
    grantOwner: owner && !self,
    revokeBadge: owner,
  };
}

/* ---------------------------------------------------------------------------
   不变式：全部在 store.mutate() 里调用
--------------------------------------------------------------------------- */

const NOT_ALLOWED = '这个操作只有站长能做。';
const SELF_ACTION = '不能对自己做这个操作。';

function selfAction(): never {
  throw new UserError(409, 'self_action', SELF_ACTION);
}

function notAllowed(message = NOT_ALLOWED): never {
  throw new UserError(403, 'not_allowed', message);
}

/** 改角色：自锁 + 「管理员不能碰 owner / 不能造 owner」+ 「至少留一个 owner」。 */
export function assertCanSetRole(
  actor: AdminActor,
  target: Pick<UserRecord, 'id' | 'role'>,
  nextRole: Role,
  ownerCount: number,
): void {
  if (actor.userId !== null && actor.userId === target.id) selfAction();

  if (actor.role === 'admin') {
    if (target.role === 'owner') notAllowed('不能修改站长的角色。');
    if (nextRole === 'owner') notAllowed('只有站长能把别人设为站长。');
  }

  // 降级最后一个 owner = 站点失去管理入口，只能改数据文件救回来。
  if (target.role === 'owner' && nextRole !== 'owner' && ownerCount <= 1) {
    throw new UserError(409, 'last_owner', '这是最后一个站长了，不能降级——先设另一个站长吧。');
  }
}

/** 封禁 / 禁言：不能操作自己；管理员不能操作 owner。 */
export function assertCanSanction(
  actor: AdminActor,
  target: Pick<UserRecord, 'id' | 'role'>,
): void {
  if (actor.userId !== null && actor.userId === target.id) selfAction();
  if (actor.role === 'admin' && target.role === 'owner') notAllowed('不能封禁或禁言站长。');
}

/** 徽章目录 / 授予：owner-only。 */
export function assertOwner(actor: AdminActor): void {
  if (actor.role !== 'owner') notAllowed('徽章由站长统一管理。');
}

/** 内容生产（发博客、发布作品、改分类）：owner-only。 */
export function assertContentOwner(actor: AdminActor): void {
  if (actor.role !== 'owner') notAllowed('内容只由站长发布，管理员可以审核但不能发布。');
}
