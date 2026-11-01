/**
 * 留言板的前端类型。
 *
 * 后端 `apps/api/src/message/types.ts` 是唯一真相，这里是它的镜像。改协议时两边都要动，
 * TS 会在字段对不上时直接报错（列表/发帖的返回值都是这些类型）。
 */

import type { Challenge, Solution } from '../blog/types';

export type MessageMode = 'text' | 'markdown';
export type MessageStatus = 'visible' | 'hidden';

/** 与 `apps/web/src/blog/types.ts` 的 `AuthorView` 同形（两套模块刻意不共用类型）。 */
export interface MessageAuthor {
  kind: 'guest' | 'user' | 'admin';
  id: string;
  nickname: string;
  avatarUrl: string;
  deleted: boolean;
  owner: boolean;
}

export interface MessageView {
  id: string;
  /** 顶层留言的楼层号；回复恒为 `null`。 */
  floor: number | null;
  author: MessageAuthor;
  mode: MessageMode;
  body: string;
  images: string[];
  status: MessageStatus;
  createdAt: string;
  replies: MessageView[];
  replyCount: number;
}

export interface MessagePage {
  messages: MessageView[];
  nextCursor: string | null;
  total: number;
  replyTotal: number;
}

export interface MessageCreated {
  message: MessageView;
  total: number;
}

export interface ReplyCreated {
  reply: MessageView;
  replyCount: number;
}

/** 编辑器提交出去的东西。`targetId` 为 `null` = 发新留言。 */
export interface ComposerSubmitInput {
  targetId: string | null;
  mode: MessageMode;
  body: string;
  images: string[];
  captcha: Solution | null;
  honeypot: string;
}

export type PostedResult =
  | { kind: 'message'; message: MessageView; total: number }
  | { kind: 'reply'; reply: MessageView; replyCount: number; parentId: string };

export interface UploadedMedia {
  name: string;
  url: string;
  mime: string;
  size: number;
}

export type { Challenge, Solution };
