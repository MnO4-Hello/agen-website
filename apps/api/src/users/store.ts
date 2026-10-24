/**
 * 账号的持久化层：`apps/api/data/users.json`。
 *
 * 与作品同一套取舍（单进程、整份重写、原子写、解析失败不重置），理由见
 * `data/json-store.ts` 顶部的注释。这里只补三件账号特有的事：
 *
 *   · **唯一性检查必须在 `mutate()` 内部做**。放到外面先查再写，两个人同时注册
 *     同一个用户名就会双双通过检查；串行队列只有在回调里才真正互斥。
 *   · **密码哈希在进队之前算**。scrypt 要 50–80ms，放在队列里会把所有其它读请求
 *     一起堵住；而它算得慢正好不影响唯一性——冲突是在队列里发现的。
 *   · **对外一律走 `toPublicUser()`**，别让 `passwordHash` 漏出去。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../data/json-store.js';
import { hashPassword } from './password.js';
import { defaultProfile, normalizeProfile, type ProfileData } from './profile-types.js';
import { toPublicUser, type PublicUser, type Role, type UserRecord, type UsersState } from './types.js';
import { UserError, normalizeKey } from './validate.js';

/**
 * `apps/api` 的绝对路径。
 *
 * 源码在 `src/users/store.ts`、编译在 `dist/users/store.js`，两者都往上两跳：
 * `users/` → `src|dist` → `api`。
 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');

function storeError(message: string): Error {
  return new UserError(500, 'user_store_error', message);
}

function createEmpty(): UsersState {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

/** 逐条检查最小结构：带着一条残缺记录跑下去，报错会出现在几百行之外。 */
function parseState(raw: unknown): UsersState {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as UsersState).items)) {
    throw storeError('users.json 的结构不对：缺少 items 数组。');
  }
  const items = (raw as UsersState).items;
  const ok = items.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      typeof item.usernameKey === 'string' &&
      typeof item.emailKey === 'string',
  );
  if (!ok) {
    throw storeError('users.json 里有结构不对的记录（缺少 id / usernameKey / emailKey），请先修好。');
  }
  /*
   * 老记录没有 `profile` 字段（个人中心上线前建的号）。这里**只在内存里补默认值**，
   * 不顺手落盘：`read()` 不该产生写入，否则每次启动都会改一次文件、还把 `.bak` 冲掉。
   * 下一次真实保存自然会把完整结构写回去。
   */
  return {
    ...(raw as UsersState),
    items: items.map((item) => ({ ...item, profile: normalizeProfile(item.profile) })),
  };
}

const store = createJsonStore<UsersState>({
  dir: DATA_DIR,
  filePath: path.join(DATA_DIR, 'users.json'),
  createEmpty,
  parse: parseState,
  fail: storeError,
});

/** 给 CLI 打印路径用。 */
export const usersFile = store.filePath;

const stamp = (): string => new Date().toISOString();

export async function listUsers(): Promise<UserRecord[]> {
  return (await store.read()).items;
}

export async function findById(id: string): Promise<UserRecord | null> {
  const state = await store.read();
  return state.items.find((item) => item.id === id) ?? null;
}

/**
 * 按登录标识找人。
 *
 * 用户名和邮箱都能登录，所以两个 Key 都要比。它们是分开建的唯一索引，
 * 理论上不会互相撞（`mno4_` 既可能是用户名也可能是邮箱本地部分），
 * 但邮箱一定含 `@`、用户名一定不含，所以实际不会歧义。
 */
export async function findByLogin(identifier: string): Promise<UserRecord | null> {
  const key = normalizeKey(identifier);
  if (!key) return null;
  const state = await store.read();
  return state.items.find((item) => item.usernameKey === key || item.emailKey === key) ?? null;
}

export async function findByUsername(username: string): Promise<UserRecord | null> {
  const key = normalizeKey(username);
  const state = await store.read();
  return state.items.find((item) => item.usernameKey === key) ?? null;
}

export interface CreateUserInput {
  username: string;
  nickname: string;
  email: string;
  /** 省略 = 不设密码（仅第三方登录）。 */
  password?: string;
  role?: Role;
  status?: UserRecord['status'];
}

/**
 * 建号。
 *
 * 冲突抛 `UserError(409, '<字段>_taken', …)`——错误码直接就是前端要挂到哪个输入框上。
 * 顺序按「用户名 → 昵称 → 邮箱」检查，与注册表单从上到下的顺序一致，
 * 这样一次只会提示最上面那个问题，不会同时红三行。
 */
export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const username = input.username.trim();
  const nickname = input.nickname.trim();
  const email = input.email.trim();
  const usernameKey = normalizeKey(username);
  const nicknameKey = normalizeKey(nickname);
  const emailKey = normalizeKey(email);

  // 先算哈希：慢的那 60ms 不该占着队列。
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  return store.mutate((state) => {
    if (state.items.some((item) => item.usernameKey === usernameKey)) {
      throw new UserError(409, 'username_taken', '这个用户名已经有人用了，换一个吧。', 'username');
    }
    if (state.items.some((item) => item.nicknameKey === nicknameKey)) {
      throw new UserError(
        409,
        'nickname_taken',
        '这个昵称已经有人用了（昵称不区分大小写）。',
        'nickname',
      );
    }
    if (state.items.some((item) => item.emailKey === emailKey)) {
      throw new UserError(409, 'email_taken', '这个邮箱已经注册过了，直接登录吧。', 'email');
    }

    const now = stamp();
    const record: UserRecord = {
      id: randomUUID(),
      username,
      usernameKey,
      nickname,
      nicknameKey,
      email,
      emailKey,
      passwordHash,
      role: input.role ?? 'user',
      status: input.status ?? 'active',
      avatarUrl: '',
      identities: [],
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      profile: defaultProfile(),
    };

    state.items.push(record);
    state.updatedAt = now;
    return record;
  });
}

/** 记一次登录时间。失败不影响登录本身，所以调用方不必 await 出错。 */
export async function recordLogin(id: string): Promise<void> {
  await store.mutate((state) => {
    const record = state.items.find((item) => item.id === id);
    if (!record) return;
    const now = stamp();
    record.lastLoginAt = now;
    state.updatedAt = now;
  });
}

/** 状态 + 对外形状一起取，登录/会话接口用得到。 */
export function publicOf(record: UserRecord): PublicUser {
  return toPublicUser(record);
}

/* ---------------------------------------------------------------------------
   资料 / 密码 / 媒体的写入
--------------------------------------------------------------------------- */

/**
 * 三个媒体槽位。注意 **`avatarUrl` 在 `UserRecord` 上，另两个在 `profile` 里**——
 * 历史上头像先于个人中心存在，导航栏与 `createAvatar()` 都读 `PublicUser.avatarUrl`，
 * 所以不能把它搬进 profile。
 */
export type MediaKind = 'avatar' | 'cover' | 'background';

export interface SaveProfileInput {
  nickname?: string;
  email?: string;
  /**
   * 只放「内容型」字段的局部更新。
   *
   * `coverUrl` / `backgroundUrl` **刻意的**不在可写范围里：它们只能由上传接口写。
   * 否则用户能塞一个外站 URL 当封面（像素追踪 + 破图），而且设置页的 draft 里
   * 存着旧的封面 URL，一次保存就会把刚上传的新封面覆盖回去。
   */
  profile?: Partial<Omit<ProfileData, 'version' | 'coverUrl' | 'backgroundUrl'>>;
  /** 乐观锁：客户端上次读到的 `updatedAt`。对不上说明别的标签页先改过了。 */
  expectUpdatedAt?: string;
}

export interface SaveProfileResult {
  record: UserRecord;
  /** 实际被改动过内容（用于「保存成功」与「什么都没改」的区分）。 */
  changed: boolean;
}

/**
 * 保存个人资料。
 *
 * 三条纪律与 `createUser()` 一致，一条都不能省：
 *
 *   · **唯一性检查写在 `mutate()` 回调里**。放到外面「先查再写」，两个标签页同时
 *     把昵称改成同一个值就会双双通过。
 *   · **乐观锁也在回调里**。放在外面同样会被并发绕过。
 *   · **不改 `avatarUrl`**，只改 `nickname / email / profile`。
 *
 * `updatedAt` 只在**内容真的变了**的时候才动：这样「保存」按钮点两次不会让
 * 「资料更新时间」白跳一下，也让乐观锁不会被空操作打乱。
 */
export async function saveProfile(id: string, input: SaveProfileInput): Promise<SaveProfileResult> {
  return store.mutate((state) => {
    const record = state.items.find((item) => item.id === id);
    if (!record) {
      // 会话有效但记录没了：只能让他重新登录。
      throw new UserError(401, 'unauthorized', '这个账号已经不存在了，请重新登录。');
    }

    if (input.expectUpdatedAt && input.expectUpdatedAt !== record.updatedAt) {
      throw new UserError(
        409,
        'profile_stale',
        '这个页面上的资料已经过期了（可能有另一个标签页改过），请刷新后再改。',
      );
    }

    let changed = false;

    if (input.nickname !== undefined && input.nickname !== record.nickname) {
      const nicknameKey = normalizeKey(input.nickname);
      const taken = state.items.some((item) => item.id !== id && item.nicknameKey === nicknameKey);
      if (taken) {
        throw new UserError(
          409,
          'nickname_taken',
          '这个昵称已经有人用了（昵称不区分大小写）。',
          'nickname',
        );
      }
      record.nickname = input.nickname;
      record.nicknameKey = nicknameKey;
      changed = true;
    }

    if (input.email !== undefined && input.email !== record.email) {
      const emailKey = normalizeKey(input.email);
      const taken = state.items.some((item) => item.id !== id && item.emailKey === emailKey);
      if (taken) {
        throw new UserError(409, 'email_taken', '这个邮箱已经注册过了。', 'email');
      }
      record.email = input.email;
      record.emailKey = emailKey;
      changed = true;
    }

    if (input.profile) {
      const next: ProfileData = { ...record.profile, ...input.profile, version: 1 };
      // 浅合并就够：`validate` 保证 `theme` / `privacy` 要么整块缺失、要么是完整对象。
      if (JSON.stringify(next) !== JSON.stringify(record.profile)) {
        record.profile = next;
        changed = true;
      }
    }

    if (changed) {
      const now = stamp();
      record.updatedAt = now;
      state.updatedAt = now;
    }
    return { record, changed };
  });
}

/** 改密码。哈希在调用方（路由层）算好再进来——scrypt 那 60ms 不该占着队列。 */
export async function updatePasswordHash(id: string, passwordHash: string): Promise<void> {
  await store.mutate((state) => {
    const record = state.items.find((item) => item.id === id);
    if (!record) throw new UserError(401, 'unauthorized', '这个账号已经不存在了，请重新登录。');
    record.passwordHash = passwordHash;
    state.updatedAt = stamp();
  });
}

/**
 * 写一个媒体槽位。
 *
 * **不动 `updatedAt`**：媒体是独立的上传通道，而设置页的 draft 里存着表单内容，
 * 一次上传如果把 `updatedAt` 推走，紧接着的保存就会被乐观锁判成「过期」。
 * 代价是「资料更新时间」不含换头像/换封面，可以接受。
 */
export async function setMedia(id: string, kind: MediaKind, url: string): Promise<UserRecord> {
  return store.mutate((state) => {
    const record = state.items.find((item) => item.id === id);
    if (!record) throw new UserError(401, 'unauthorized', '这个账号已经不存在了，请重新登录。');
    if (kind === 'avatar') record.avatarUrl = url;
    else if (kind === 'cover') record.profile.coverUrl = url;
    else record.profile.backgroundUrl = url;
    state.updatedAt = stamp();
    return record;
  });
}

/** 按用户名（登录用的那个）找公开主页的主人，顺带给出注册顺序（前 10 位算早期用户）。 */
export async function findByUsernameWithIndex(
  username: string,
): Promise<{ record: UserRecord; index: number } | null> {
  const key = normalizeKey(username);
  if (!key) return null;
  const state = await store.read();
  const index = state.items.findIndex((item) => item.usernameKey === key);
  return index < 0 ? null : { record: state.items[index]!, index };
}

/**
 * 这些 URL 还有没有人在用？
 *
 * 媒体文件名是**内容哈希**，两个人上传同一张图会共用一份文件。所以删头像时不能
 * 直接删文件，必须先问一遍「全部记录里还有人引用它吗」。
 */
export async function collectReferencedMedia(): Promise<Set<string>> {
  const state = await store.read();
  const used = new Set<string>();
  for (const item of state.items) {
    if (item.avatarUrl) used.add(item.avatarUrl);
    if (item.profile.coverUrl) used.add(item.profile.coverUrl);
    if (item.profile.backgroundUrl) used.add(item.profile.backgroundUrl);
  }
  return used;
}
