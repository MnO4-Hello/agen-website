/**
 * 博客的领域类型（前端镜像）。
 *
 * **真源是 `apps/api/src/blog/types.ts`**，改字段名时两边一起改。镜像而不是共享包，
 * 理由与 `works/api.ts` 相同：Vite 与 tsc 两套构建对跨 workspace 路径的解析不一样，
 * 为几个 interface 引一个共享包得不偿失。
 *
 * 这里只镜像「服务端会发出来的东西」。落盘结构（`PostRecord` / `ReplyRecord`，含
 * `ipHash`、被隐藏的正文、草稿）**前端永远不需要**，也就不镜像——少一份类型就少一次
 * 「不小心把它渲染出来」的机会。
 */

export type VoteValue = -1 | 0 | 1;
export type PostStatus = 'draft' | 'published';
export type ReplyStatus = 'visible' | 'hidden';
export type AuthorKind = 'admin' | 'user' | 'guest';
export type PostSort = 'new' | 'hot';

export interface AuthorView {
  kind: AuthorKind;
  id: string;
  nickname: string;
  avatarUrl: string;
  /** 账号已注销：昵称仍显示，另加一个灰标。 */
  deleted: boolean;
  /** 显示「站长」徽章。 */
  owner: boolean;
}

export interface CategoryView {
  id: string;
  name: string;
  key: string;
  order: number;
  count: number;
}

export interface TagView {
  key: string;
  label: string;
  count: number;
}

export interface PostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  /** 显式上传的封面；空串 = 没有封面（不展示左侧方图）。 */
  coverImage: string;
  category: { id: string; name: string } | null;
  tags: string[];
  author: AuthorView;
  score: number;
  up: number;
  down: number;
  replyCount: number;
  locked: boolean;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  lastReplyAt: string | null;
  myVote: VoteValue;
}

export interface PostDetail extends PostSummary {
  markdown: string;
}

export interface ReplyView {
  id: string;
  floor: number;
  author: AuthorView;
  /** 被隐藏的楼层恒为空串（显示「该回复已删除」，楼层号照旧占位）。 */
  body: string;
  replyToFloor: number | null;
  replyToName: string;
  score: number;
  up: number;
  down: number;
  myVote: VoteValue;
  status: ReplyStatus;
  createdAt: string;
}

export interface PostList {
  posts: PostSummary[];
  nextCursor: string | null;
  total: number;
}

export interface PostPage {
  post: PostDetail;
  replies: ReplyView[];
  replyCursor: string | null;
}

export interface ReplyPage {
  replies: ReplyView[];
  nextCursor: string | null;
}

/**
 * 人机验证的题面（`GET /api/blog/captcha`）。
 *
 * 载荷形状与 **ALTCHA** 一致：`challenge = sha256(salt + number)`，客户端要找出
 * `number`。服务端不存答案（无状态），只记「这道题已经用过」来防重放。
 */
export interface Puzzle {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export interface Challenge extends Puzzle {
  expiresAt: string;
  /** 服务端要求的最短耗时（毫秒）。前端只用来提示，真正的判定在服务端。 */
  minElapsedMs: number;
}

/** 交回服务端的解：原题 + 找到的 number（`took` 只用于展示）。 */
export interface Solution extends Puzzle {
  number: number;
  took: number;
}

export interface VoteResult {
  score: number;
  up: number;
  down: number;
  myVote: VoteValue;
}

/** 发回复要提交的东西。游客多一层 `captcha`，登录用户完全不传。 */
export interface ReplyInput {
  body: string;
  replyToFloor: number | null;
  /** 工作量证明的解（只有游客需要）。 */
  captcha: Solution | null;
  /** 蜜罐字段：真人永远看不到它，值非空即被服务端判为机器。 */
  honeypot: string;
}

export interface ReplyCreated {
  reply: ReplyView;
  replyCount: number;
}
