/**
 * 留言板的持久化。
 *
 * 单文件 `data/message.json`，**一条串行队列**（`createJsonStore` 保证）。与 `blog/store.ts`
 * 的区别只有一处：博客的回复挂在帖子下面（`post.replies[]`），留言板是顶层列表 + 一层
 * 回复，所以记录**平铺**在一个数组里，靠 `parentId` 区分。这样「按时间翻页」和「取某条
 * 留言的回复」都是同一次 filter，不需要两套结构。
 *
 * 排序：**楼层号降序（最新在前）**，游标是楼层号，翻页条件是 `floor < f`。博客的回复是
 * 升序（`floor > f`）——方向相反是最容易抄错的一行。
 *
 * 删除：只做 `status: 'hidden'` 软删（与博客一致）。但两者的**表现不同**：
 *   · 隐藏顶层留言 → 从公开列表里整个消失（垃圾广告不该留个空位）；
 *   · 隐藏回复 → 留一个「该留言已删除」的空位（否则引用它的上下文会断）。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../data/json-store.js';
import type { AuthorSnapshot, MessageMode, MessageRecord, MessageState, MessageStatus } from './types.js';
import {
  MAX_MESSAGES,
  MAX_REPLIES_PER_MESSAGE,
  MessageError,
  isImageName,
} from './validate.js';

/** 源码在 `src/message/store.ts`、编译在 `dist/message/store.js`，两者都往上两跳。 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');

export const messageFile = path.join(DATA_DIR, 'message.json');

/** 一条留言最多带回来多少条回复。再多就靠 `replyCount` 说明「还有 N 条」。 */
export const MAX_VIEW_REPLIES = 100;

const stamp = (): string => new Date().toISOString();

/* ---------------------------------------------------------------------------
   store 实例
--------------------------------------------------------------------------- */

function createEmpty(): MessageState {
  return { version: 1, updatedAt: stamp(), nextFloor: 1, items: [] };
}

function parseState(raw: unknown): MessageState {
  if (typeof raw !== 'object' || raw === null) {
    throw new MessageError(500, 'message_store_error', 'message.json 的结构不对：顶层不是对象。');
  }
  const state = raw as MessageState;
  if (!Array.isArray(state.items)) {
    throw new MessageError(500, 'message_store_error', 'message.json 的结构不对：缺少 items。');
  }
  for (const item of state.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      (item.parentId !== null && typeof item.parentId !== 'string') ||
      (item.status !== 'visible' && item.status !== 'hidden')
    ) {
      throw new MessageError(
        500,
        'message_store_error',
        'message.json 里有结构不对的记录（缺少 id / parentId / status），请先修好（同目录有 .bak）。',
      );
    }
  }
  // 楼层计数器丢了就从现存最大楼层往后接，不让它变成 NaN 一路写进新记录。
  if (!Number.isInteger(state.nextFloor) || state.nextFloor < 1) {
    const maxFloor = state.items.reduce((max, item) => Math.max(max, item.floor ?? 0), 0);
    state.nextFloor = maxFloor + 1;
  }
  return state;
}

const store = createJsonStore<MessageState>({
  dir: DATA_DIR,
  filePath: messageFile,
  createEmpty,
  parse: parseState,
  fail: (message) => new MessageError(500, 'message_store_error', message),
});

/* ---------------------------------------------------------------------------
   游标
--------------------------------------------------------------------------- */

function encodeFloorCursor(floor: number): string {
  return Buffer.from(JSON.stringify({ f: floor }), 'utf8').toString('base64url');
}

function decodeFloorCursor(raw: string): number {
  const bad = (): never => {
    throw new MessageError(400, 'bad_cursor', '分页游标无效，刷新一下就好。');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  const payload = parsed as { f?: unknown };
  if (typeof payload !== 'object' || payload === null || typeof payload.f !== 'number') {
    return bad();
  }
  if (!Number.isInteger(payload.f) || payload.f < 0) return bad();
  return payload.f;
}

/* ---------------------------------------------------------------------------
   派生值
--------------------------------------------------------------------------- */

function visibleReplyCount(state: MessageState, parentId: string): number {
  let count = 0;
  for (const item of state.items) {
    if (item.parentId === parentId && item.status === 'visible') count += 1;
  }
  return count;
}

/** 某条留言的回复，按写入顺序（= 时间升序）。隐藏的也带上，前端渲染成占位。 */
function repliesOf(state: MessageState, parentId: string): MessageRecord[] {
  return state.items.filter((item) => item.parentId === parentId).slice(0, MAX_VIEW_REPLIES);
}

function topLevel(state: MessageState, includeHidden: boolean): MessageRecord[] {
  return state.items
    .filter((item) => item.parentId === null && (includeHidden || item.status === 'visible'))
    .sort((a, b) => (b.floor ?? 0) - (a.floor ?? 0));
}

/* ---------------------------------------------------------------------------
   公开读
--------------------------------------------------------------------------- */

export interface MessageBundle {
  record: MessageRecord;
  replies: MessageRecord[];
  replyCount: number;
}

export interface MessagePage {
  messages: MessageBundle[];
  nextCursor: string | null;
  /** 可见留言总数（不含隐藏）。 */
  total: number;
  /** 全部可见回复数，给页头统计用。 */
  replyTotal: number;
}

export async function listMessages(query: { limit: number; cursor: string }): Promise<MessagePage> {
  return store.read().then((state) => {
    const all = topLevel(state, false);
    const after = query.cursor ? decodeFloorCursor(query.cursor) : Number.POSITIVE_INFINITY;
    // 降序列表：游标之后的那些是「更早的」，即 floor 更小。
    const rest = all.filter((item) => (item.floor ?? 0) < after);
    const page = rest.slice(0, query.limit);
    const last = page[page.length - 1];

    let replyTotal = 0;
    for (const item of state.items) {
      if (item.parentId !== null && item.status === 'visible') replyTotal += 1;
    }

    return {
      messages: page.map((record) => ({
        record,
        replies: repliesOf(state, record.id),
        replyCount: visibleReplyCount(state, record.id),
      })),
      nextCursor:
        last && rest.length > page.length ? encodeFloorCursor(last.floor ?? 0) : null,
      total: all.length,
      replyTotal,
    };
  });
}

/* ---------------------------------------------------------------------------
   写
--------------------------------------------------------------------------- */

export interface NewMessageInput {
  mode: MessageMode;
  body: string;
  images: string[];
  author: AuthorSnapshot;
  ipHash: string;
}

export interface NewReplyInput {
  body: string;
  images: string[];
  author: AuthorSnapshot;
  ipHash: string;
}

export async function addMessage(input: NewMessageInput): Promise<{
  record: MessageRecord;
  total: number;
}> {
  return store.mutate((state) => {
    if (state.items.filter((item) => item.parentId === null).length >= MAX_MESSAGES) {
      throw new MessageError(
        409,
        'too_many_messages',
        '留言板满了，先等站长清理一下再来吧。',
      );
    }

    const record: MessageRecord = {
      id: randomUUID(),
      floor: state.nextFloor,
      parentId: null,
      author: input.author,
      mode: input.mode,
      body: input.body,
      images: input.images.filter(isImageName),
      status: 'visible',
      ipHash: input.ipHash,
      createdAt: stamp(),
      deletedAt: null,
    };
    state.nextFloor += 1;
    state.items.push(record);

    return {
      record,
      total: state.items.filter((item) => item.parentId === null && item.status === 'visible')
        .length,
    };
  });
}

export async function addReply(
  parentId: string,
  input: NewReplyInput,
): Promise<{ record: MessageRecord; replyCount: number }> {
  return store.mutate((state) => {
    const parent = state.items.find((item) => item.id === parentId);
    if (!parent || parent.parentId !== null || parent.status !== 'visible') {
      throw new MessageError(404, 'not_found', '这条留言已经不在了。');
    }
    if (state.items.filter((item) => item.parentId === parentId).length >= MAX_REPLIES_PER_MESSAGE) {
      throw new MessageError(409, 'too_many_replies', '这条留言的回复太多了，换个地方聊吧。');
    }

    const record: MessageRecord = {
      id: randomUUID(),
      floor: null,
      parentId,
      author: input.author,
      // 回复只有纯文本 + 图片：Markdown 只开放给顶层留言（见 `validate.ts`）。
      mode: 'text',
      body: input.body,
      images: input.images.filter(isImageName),
      status: 'visible',
      ipHash: input.ipHash,
      createdAt: stamp(),
      deletedAt: null,
    };
    state.items.push(record);

    return { record, replyCount: visibleReplyCount(state, parentId) };
  });
}

export async function setMessageStatus(
  id: string,
  status: MessageStatus,
): Promise<MessageRecord> {
  return store.mutate((state) => {
    const record = state.items.find((item) => item.id === id);
    if (!record) throw new MessageError(404, 'not_found', '没有这条留言。');
    record.status = status;
    record.deletedAt = status === 'hidden' ? stamp() : null;
    return record;
  });
}

/* ---------------------------------------------------------------------------
   后台读
--------------------------------------------------------------------------- */

export async function listMessagesForAdmin(query: {
  limit: number;
  cursor: string;
  status: '' | MessageStatus;
  q: string;
}): Promise<{ messages: MessageBundle[]; nextCursor: string | null; total: number }> {
  return store.read().then((state) => {
    const needle = query.q.toLowerCase();
    const all = topLevel(state, true).filter((item) => {
      if (query.status && item.status !== query.status) return false;
      if (!needle) return true;
      return (
        item.body.toLowerCase().includes(needle) ||
        item.author.nickname.toLowerCase().includes(needle)
      );
    });

    const after = query.cursor ? decodeFloorCursor(query.cursor) : Number.POSITIVE_INFINITY;
    const rest = all.filter((item) => (item.floor ?? 0) < after);
    const page = rest.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
      messages: page.map((record) => ({
        record,
        replies: repliesOf(state, record.id),
        replyCount: visibleReplyCount(state, record.id),
      })),
      nextCursor:
        last && rest.length > page.length ? encodeFloorCursor(last.floor ?? 0) : null,
      total: all.length,
    };
  });
}
