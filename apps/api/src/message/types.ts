/**
 * 留言板的领域类型。
 *
 * 与 `blog/types.ts` **同形但不共用**：博客的 `AuthorSnapshot` / `ReplyView` 是博客模块的
 * 内部形状，跨模块 import 会把它变成全站契约——改一个字段要审两遍。这里只保留两边真正
 * 一致的那一小块（作者快照的六个字段），其余各写各的。
 *
 * 两层结构，不做楼中楼：
 *   · `parentId === null` → 顶层留言，有楼层号，是列表的唯一单位；
 *   · `parentId !== null` → 回复，只能挂在顶层留言上（挂到回复上报 400）。
 */

export type MessageMode = 'text' | 'markdown';
export type MessageStatus = 'visible' | 'hidden';

/** 落盘的作者快照：昵称/头像存那一刻的值，用户后来改名不该改写历史。 */
export interface AuthorSnapshot {
  kind: 'guest' | 'user' | 'admin';
  /** 只有 `kind: 'user'` 才有；游客与站长为空串。 */
  id: string;
  nickname: string;
  avatarUrl: string;
}

export interface MessageRecord {
  id: string;
  /** 顶层留言从 1 起递增；回复恒为 `null`（回复不需要楼层号）。 */
  floor: number | null;
  parentId: string | null;
  author: AuthorSnapshot;
  /** 回复恒为 `'text'`：留言可以选 Markdown，回复只给纯文本 + 图片。 */
  mode: MessageMode;
  /** `text` 模式是纯文本（保留 `\n`）；`markdown` 模式是源码。软删后仍留在文件里。 */
  body: string;
  /** 附图文件名（`m-<hash>.<ext>`），顺序即展示顺序；markdown 模式恒为空。 */
  images: string[];
  status: MessageStatus;
  ipHash: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface MessageState {
  version: 1;
  updatedAt: string;
  /** 下一个可用的楼层号。只增不减，删掉的楼层不回收。 */
  nextFloor: number;
  /** 平铺存放：顶层与回复混在一个数组里，靠 `parentId` 区分。 */
  items: MessageRecord[];
}

/** `userId → 当前昵称/头像/是否可用/是否站长`。一次读全表建出来的 Map。 */
export type LiveAuthors = Map<
  string,
  { nickname: string; avatarUrl: string; active: boolean; owner: boolean }
>;

export interface AuthorView {
  kind: 'guest' | 'user' | 'admin';
  id: string;
  nickname: string;
  avatarUrl: string;
  /** 账号已被禁用/删除（只影响 `kind: 'user'`）。 */
  deleted: boolean;
  /** 站长（`role === 'owner' | 'admin'`）——前端据此打徽章、决定回复默认是否展开。 */
  owner: boolean;
}

export interface MessageView {
  id: string;
  floor: number | null;
  author: AuthorView;
  mode: MessageMode;
  /** 被隐藏时是空串。 */
  body: string;
  /** 完整 URL。 */
  images: string[];
  status: MessageStatus;
  createdAt: string;
  /** 回复，时间升序，最多 100 条（截断量体现在 `replyCount` 里）。 */
  replies: MessageView[];
  /** 可见回复总数。 */
  replyCount: number;
}

/** 图片直链前缀。库里只存文件名，对外拼这个前缀——换域名/换前缀只改这一处。 */
export const MESSAGE_IMAGE_PREFIX = '/api/messages/media/';

export function imageUrlOf(name: string): string {
  return `${MESSAGE_IMAGE_PREFIX}${name}`;
}

/**
 * 快照 → 对外视图。
 *
 * 三条纪律（与 `blog/types.ts:256` 的 `authorView` 一致）：
 *   · 账号查不到 → `deleted: true`，昵称仍用快照里的（人删号了，留言还是他说的）；
 *   · 站长判定**每次都回表**，不在落盘时冻结（提权/降权要立刻生效）；
 *   · `kind: 'admin'` 恒为站长——那是「站长用隐藏后台发的」，本就该有徽章。
 */
export function authorView(snapshot: AuthorSnapshot, live: LiveAuthors): AuthorView {
  if (snapshot.kind === 'user') {
    const found = live.get(snapshot.id);
    if (!found) {
      return {
        kind: 'user',
        id: '',
        nickname: snapshot.nickname,
        avatarUrl: snapshot.avatarUrl,
        deleted: true,
        owner: false,
      };
    }
    return {
      kind: 'user',
      id: snapshot.id,
      nickname: found.nickname,
      avatarUrl: found.avatarUrl,
      deleted: !found.active,
      owner: found.owner,
    };
  }
  return {
    kind: snapshot.kind,
    id: '',
    nickname: snapshot.nickname,
    avatarUrl: snapshot.avatarUrl,
    deleted: false,
    owner: snapshot.kind === 'admin',
  };
}

/**
 * 记录 → 视图。
 *
 * 默认**不**把隐藏记录的正文外发：`body` 置空、`images` 清空。留着的话「隐藏」在
 * DevTools 里等于没做。后台要看得见被藏起来的是什么，走 `toAdminMessageView`。
 */
export function toMessageView(
  record: MessageRecord,
  live: LiveAuthors,
  replies: MessageRecord[] = [],
  replyCount = 0,
): MessageView {
  return viewOf(record, live, replies, replyCount, false);
}

/** 后台视图：隐藏的正文照旧返回，只把 `status` 标出来让界面自己显示「已隐藏」。 */
export function toAdminMessageView(
  record: MessageRecord,
  live: LiveAuthors,
  replies: MessageRecord[] = [],
  replyCount = 0,
): MessageView {
  return viewOf(record, live, replies, replyCount, true);
}

function viewOf(
  record: MessageRecord,
  live: LiveAuthors,
  replies: MessageRecord[],
  replyCount: number,
  reveal: boolean,
): MessageView {
  const visible = record.status === 'visible' || reveal;
  return {
    id: record.id,
    floor: record.floor,
    author: authorView(record.author, live),
    mode: record.mode,
    body: visible ? record.body : '',
    images: visible ? record.images.map(imageUrlOf) : [],
    status: record.status,
    createdAt: record.createdAt,
    replies: replies.map((reply) => viewOf(reply, live, [], 0, reveal)),
    replyCount,
  };
}
