/**
 * 「授予徽章」的对外形状。
 *
 * 站内现在有**三类**徽章，别混：
 *
 *   1. `systemBadges`：服务端按 role / 注册年份算出来的（站长、管理员、2026 年加入、
 *      早期用户），不存任何数据，**不可授予也不可撤**；
 *   2. `grantedBadges`（本文件）：站长在后台定义目录、逐人授予，存
 *      `apps/api/data/badges.json`；
 *   3. `customBadges`：用户自己在设置页造着玩的（存在 `profile.badges`）。
 *
 * 为什么授予的走独立文件而不是塞进 `profile`：`profile` 是用户可以通过
 * `PATCH /api/account/profile` 整块提交的，放进去就得在字段白名单里再挡一次；
 * 独立存储让「用户改不了自己的徽章」这件事由**结构**保证，而不是靠校验。
 *
 * 隐私：授予徽章**不受** `privacy.badges` 约束（与 `systemBadges` 一致）——
 * 站长背书是公开身份，而且 `toPublicProfile()` 本来就无视那个开关发系统徽章。
 * 这不是漏改，别「修」成受隐私控制。
 */

import type { PublicProfile } from './profile-types.js';

export interface GrantedBadgeView {
  /** 目录里的定义 id（`g-…`）。 */
  badgeId: string;
  label: string;
  color: string;
  emoji: string;
  /** hover 提示（默认「由站长授予」）。 */
  hint: string;
  grantedAt: string;
  /** 目录项已下架：徽章仍显示，但不能再授给别人。 */
  archived: boolean;
}

/** 给公开主页用：徽章数要一起算进统计条，否则「徽章 2」与实际可见数量对不上。 */
export function attachGrantedBadges<P extends PublicProfile>(
  profile: P,
  views: GrantedBadgeView[],
): P & { grantedBadges: GrantedBadgeView[] } {
  return {
    ...profile,
    grantedBadges: views,
    stats: { ...profile.stats, badges: profile.stats.badges + views.length },
  };
}
