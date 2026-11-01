/**
 * 留言板与「站内账号」之间的桥。
 *
 * ⚠️ 与 `blog/authors.ts` **同构**（本文件是照它写的）：那里是博客的，这里是留言板的。
 * 之所以不共用，是因为共用就得把 `blog/types.ts` 里的 `AuthorSnapshot` / `LiveAuthors`
 * 提升成全站契约——为 45 行代码去动一个已经在跑的模块不值得。**改这里时记得看一眼那边**，
 * 两处唯一的差别是「站长」的判定必须始终一致（`role === 'owner' || role === 'admin'`）。
 *
 * 关键性能纪律：**一次 `listUsers()` 建 Map，不要每条留言各调一次 `findById()`**。
 */

import { isActive } from '../users/moderation.js';
import { listUsers } from '../users/store.js';
import type { AuthorSnapshot, LiveAuthors } from './types.js';

/** 读一次全表，得到「userId → 当前昵称/头像/是否可用/是否站长」。 */
export async function loadLiveAuthors(): Promise<LiveAuthors> {
  const users = await listUsers();
  const map: LiveAuthors = new Map();
  for (const user of users) {
    map.set(user.id, {
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      active: isActive(user),
      // 只有 `owner` 才是「站长」——管理员是另一档，与 blog/authors.ts 保持一致。
      owner: user.role === 'owner',
    });
  }
  return map;
}

/**
 * 「站长」这个身份在当前数据下的样子。
 *
 * 后台会话（`agen_admin` cookie）里只有 `{ sub: ADMIN_USER }`，**没有 UserRecord 的 id**，
 * 所以站长回复的作者是 `kind: 'admin'`，昵称/头像取站内 owner 账号（没有就退回 admin，
 * 再退回「站长」）。靠用户名去 users.json 反查同名 owner 是猜测，换个环境变量就指向别人。
 */
export async function ownerIdentity(): Promise<AuthorSnapshot> {
  const users = await listUsers();
  const active = users.filter((user) => isActive(user));
  const owner =
    active.find((user) => user.role === 'owner') ?? active.find((user) => user.role === 'admin');
  return {
    kind: 'admin',
    id: '',
    nickname: owner?.nickname ?? '站长',
    avatarUrl: owner?.avatarUrl ?? '',
  };
}
