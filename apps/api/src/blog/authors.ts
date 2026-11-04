/**
 * 博客与「站内账号」之间的桥。
 *
 * 为什么单独一层：`blog/store.ts` 刻意不 import users 模块——两个 store 互相依赖会让
 * 串行队列的边界变得难以推理（谁能阻塞谁、谁在谁的临界区里读盘）。所有「把 userId
 * 换成昵称/头像」「站长署名是谁」这类跨域的事都收在这里，由路由层调用。
 *
 * 关键性能纪律：**一次 `listUsers()` 建 Map，不要每条回复各调一次 `findById()`**。
 * 后者会把 users.json 读 N 遍，一页 20 条回复就是 20 次磁盘读。
 */

import { isActive } from '../users/moderation.js';
import { listUsers } from '../users/store.js';
import type { AuthorSnapshot, LiveAuthors } from './types.js';

/** 读一次全表，得到「userId → 当前昵称/头像/是否可用」。 */
export async function loadLiveAuthors(): Promise<LiveAuthors> {
  const users = await listUsers();
  const map = new Map<string, { nickname: string; avatarUrl: string; active: boolean; owner: boolean }>();
  for (const user of users) {
    map.set(user.id, {
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      active: isActive(user),
      /*
       * 只有 `owner` 才显示「站长」徽章。
       *
       * 这里原本是 `owner || admin`——三级权限落地前 admin 与 owner 没有区别，
       * 现在有了：管理员是「帮忙看场子的人」，不该顶着站长的名头说话。
       */
      owner: user.role === 'owner',
    });
  }
  return map;
}

/**
 * 帖子的作者署名。
 *
 * 后台会话（`agen_admin` cookie）只是一个无状态 token，**没有 UserRecord 的 id 可依**——
 * 所以帖子作者是 `kind: 'admin'`，昵称/头像取站内 owner 账号（没有就退回 admin，
 * 再退回「站长」）。靠用户名去 users.json 反查同名的 owner 是猜测，换个会话就指向
 * 别人了，不干这种事。
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
