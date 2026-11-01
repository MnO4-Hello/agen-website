/**
 * 账户视图的数据源（与 `post-source.ts` / `guestbook.ts` 同一思路）。
 *
 * 抽这一层不是为了「将来换后端」，而是为了让 `?preview=accounts` 能用内存假数据
 * 画出完整版面——直接调真接口的话，DEV 截图通道里没有管理员 cookie，
 * 视图会 401 之后把自己踢回登录页，什么都看不到。
 *
 * 徽章目录也走同一个 source：账户行的「徽章」面板和独立的「徽章」视图要读的是
 * 同一份目录，分成两个客户端只会让两边对「哪枚已下架」判断不一致。
 */

import {
  archiveAdminBadge,
  banAccount,
  createAdminBadge,
  fetchAdminAccounts,
  fetchAdminBadges,
  grantAdminBadge,
  muteAccount,
  restoreAdminBadge,
  revokeAdminBadge,
  setAccountRole,
  unbanAccount,
  unmuteAccount,
  updateAdminBadge,
  type AccountRole,
  type AdminAccount,
  type AdminAccountPage,
  type AdminAccountQuery,
  type AdminBadge,
  type AdminBadgeCatalog,
  type ApiResult,
  type BadgeDraft,
} from '../api';

type AccountResult = ApiResult<{ account: AdminAccount }>;
type BadgeResult = ApiResult<{ badge: AdminBadge }>;
type ArchiveResult = ApiResult<{ badge: AdminBadge; affectedGrants: number }>;

export interface AccountSource {
  list(query: AdminAccountQuery): Promise<ApiResult<AdminAccountPage>>;
  setRole(id: string, role: AccountRole): Promise<AccountResult>;
  ban(id: string, days: number, reason: string): Promise<AccountResult>;
  unban(id: string): Promise<AccountResult>;
  mute(id: string, days: number, reason: string): Promise<AccountResult>;
  unmute(id: string): Promise<AccountResult>;

  catalog(): Promise<ApiResult<AdminBadgeCatalog>>;
  createBadge(draft: BadgeDraft): Promise<BadgeResult>;
  updateBadge(id: string, draft: BadgeDraft): Promise<BadgeResult>;
  archiveBadge(id: string): Promise<ArchiveResult>;
  restoreBadge(id: string): Promise<ArchiveResult>;
  grant(userId: string, badgeId: string): Promise<AccountResult>;
  revoke(userId: string, badgeId: string): Promise<AccountResult>;
}

export const liveAccountSource: AccountSource = {
  list: (query) => fetchAdminAccounts(query),
  setRole: (id, role) => setAccountRole(id, role),
  ban: (id, days, reason) => banAccount(id, days, reason),
  unban: (id) => unbanAccount(id),
  mute: (id, days, reason) => muteAccount(id, days, reason),
  unmute: (id) => unmuteAccount(id),
  catalog: () => fetchAdminBadges(),
  createBadge: (draft) => createAdminBadge(draft),
  updateBadge: (id, draft) => updateAdminBadge(id, draft),
  archiveBadge: (id) => archiveAdminBadge(id),
  restoreBadge: (id) => restoreAdminBadge(id),
  grant: (userId, badgeId) => grantAdminBadge(userId, badgeId),
  revoke: (userId, badgeId) => revokeAdminBadge(userId, badgeId),
};
