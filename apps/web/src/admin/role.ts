/**
 * 「我现在是站长还是管理员」——后台视图里唯一需要知道这件事的地方。
 *
 * 为什么不把这个值塞进每个视图的工厂函数参数：`shell.ts` 的工厂签名是 `() => AdminView`，
 * 改成 `(ctx) => AdminView` 就要同时改 6 个视图 + `preview.ts` 的注入点，而真正需要它的
 * 只有 `posts.ts` / `guestbook.ts` 里那几行「要不要显示发布按钮」。
 *
 * 默认值是 `admin`（权限更小的那个）：万一哪天忘了设置，界面会少显示几个按钮，
 * 而不是多显示——多显示的按钮点下去会被后端 403，但少显示只是不好看。
 *
 * ⚠️ 这只是**界面层**的判断。真正拦人的是 `admin/guard.ts` 的 `OWNER_ONLY` 路由表，
 * 两者都要有：前者决定看不看得见，后者决定做不做得成。
 */

import type { AdminRole } from './api';

let current: AdminRole = 'admin';

export function setAdminRole(role: AdminRole | undefined): void {
  current = role === 'owner' ? 'owner' : 'admin';
}

export function adminRole(): AdminRole {
  return current;
}

/** 站长：能发博客、发布作品、改分类、改徽章。 */
export function isOwner(): boolean {
  return current === 'owner';
}
