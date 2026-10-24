/**
 * 账号的数据形状。
 *
 * 两个刻意的设计：
 *
 *   1. **`username` 与 `nickname` 是两件事**。用户名只用来登录、永不对外展示；
 *      昵称才是别人看到的名字，允许任意语言与符号。所以登录标识、唯一性判定、
 *      界面展示走的是不同字段，别在第 3 个地方把它们混起来。
 *   2. **每个「唯一字段」都存一份 `*Key`**（`trim → NFKC → toLowerCase`）。
 *      唯一性只比 Key：`MnO4_` 与 `mno4_` 必须算同一个，全角 `Ａdmin` 归一后要能
 *      命中保留字。原值照旧保留，用于展示。
 */

import type { ProfileData } from './profile-types.js';

/** 四个层级里的三个「人」；游客不是一个账号，所以不在这个联合里。 */
export type Role = 'user' | 'admin' | 'owner';

/** 停用比删除安全：账号还在，只是登不进来。 */
export type UserStatus = 'active' | 'disabled';

/**
 * 第三方登录的绑定关系。
 *
 * 本期恒为空数组——留字段是为了将来接 OAuth 时不必迁移 `users.json`：
 * `provider` + `subject` 是外部账号的唯一标识，`passwordHash` 允许为 `null`
 * 表示「这个号只能通过第三方登录」。
 */
export interface IdentityLink {
  provider: string;
  subject: string;
  linkedAt: string;
}

export interface UserRecord {
  /** 会话 token 的 `sub` 用它，不用用户名——改名不会把已登录的人踢下线。 */
  id: string;
  username: string;
  usernameKey: string;
  nickname: string;
  nicknameKey: string;
  email: string;
  emailKey: string;
  /** `scrypt$N$r$p$salt$hash`；`null` = 只能第三方登录（本期不会出现）。 */
  passwordHash: string | null;
  role: Role;
  status: UserStatus;
  /** 本期恒为空串，前端按「首字符 + 派生色」画默认头像。 */
  avatarUrl: string;
  identities: IdentityLink[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /**
   * 展示型资料（签名、简介、徽章、主题、隐私…）。
   *
   * 为什么和账号数据放在同一份文件里：一次保存里往往同时要改 `nickname`
   * （唯一性校验在 users.json）和签名等展示字段，而 JSON store 没有跨文件事务。
   * 拆成两份会出现「昵称写成功、签名写失败」的半保存。
   *
   * 老记录没有这个字段时由 `store.ts` 的 `parseState()` 在内存里补默认值，
   * **不做一次性的落盘迁移**——下一次真实写入自然会带上完整结构。
   */
  profile: ProfileData;
}

export interface UsersState {
  /** 留给以后的迁移用，现在只会是 1。 */
  version: 1;
  updatedAt: string;
  items: UserRecord[];
}

/**
 * 对外的账号形状。
 *
 * **唯一出口是 `toPublicUser()`**：任何路由都不许直接把 `UserRecord` 发出去，
 * 那会把 `passwordHash`、`*Key`、`status` 一起泄漏给浏览器。
 * `email` 保留——它只出现在「本人的会话响应」里，个人中心要显示它。
 */
export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  email: string;
  role: Role;
  avatarUrl: string;
  createdAt: string;
}

export const ROLE_LABEL: Record<Role, string> = {
  user: '普通用户',
  admin: '管理员',
  owner: '站长',
};

export function toPublicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    nickname: record.nickname,
    email: record.email,
    role: record.role,
    avatarUrl: record.avatarUrl,
    createdAt: record.createdAt,
  };
}
