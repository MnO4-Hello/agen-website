/**
 * 博客 / 社区的领域类型。
 *
 * 这里是「唯一真相」，前端 `apps/web/src/blog/types.ts` 与 `apps/web/src/admin/api.ts`
 * 各自镜像了一份。改字段名时三处一起改——没有生成器，也不想为此引入一个跨 workspace
 * 的共享包（Vite 与 tsc 两套构建的路径解析会立刻变复杂）。
 *
 * 三条设计取舍，读代码前先知道：
 *
 *   1. **派生值一律不落盘**（`score` / `up` / `down` / `replyCount` / `lastReplyAt` /
 *      `excerpt` / 分类的 `count`）。`blog.json` 是整份重写，任何「计数 + 内容」两处写
 *      都可能只成功一半而永久漂移；派生值不可能漂移，而且列表 / 详情 / 后台三处共用
 *      同一份算法（`pickSummary` / `pickReply`），不会出现「列表说 5 条、详情说 6 条」。
 *   2. **回复永不硬删除**（`status: 'hidden'` 是软删）。楼层号 `floor` 一旦分配就写死，
 *      这样 `#3` 这类引用永远指向第 3 楼，不会因为删了中间一层而集体错位。
 *   3. **对外只发 `pick*()` 的产物**，路由不许直接 `send(PostRecord)`——里面存着
 *      `ipHash`、未发布的草稿、以及被管理员隐藏的正文。
 */

export type VoteValue = -1 | 0 | 1;
export type PostStatus = 'draft' | 'published';
export type ReplyStatus = 'visible' | 'hidden';
/** `admin` = 后台以站长身份发的帖子；`user` = 站内账号的回复；`guest` = 免登录游客。 */
export type AuthorKind = 'admin' | 'user' | 'guest';

/** 写入时拍下来的作者快照（账号注销后历史仍可读）。 */
export interface AuthorSnapshot {
  kind: AuthorKind;
  /** `user` 是 users.json 的 id；`admin` / `guest` 恒为空串。 */
  id: string;
  nickname: string;
  avatarUrl: string;
}

/** 一人一票：键是 userId，值 1 / -1；撤销投票就是删键。 */
export type VoteMap = Record<string, 1 | -1>;

export interface ReplyRecord {
  id: string;
  /** 1 起，分配后**永不改变**（软删除也不回收、不重排）。 */
  floor: number;
  author: AuthorSnapshot;
  /** 纯文本（保留 `\n`）。软删除后仍留在文件里，只是对外不再返回。 */
  body: string;
  /** 引用的楼层号；`null` = 直接回复楼主。 */
  replyToFloor: number | null;
  /** 引用那一刻被引用人的昵称快照——对方后来改名，不该改写历史引用。 */
  replyToName: string;
  status: ReplyStatus;
  votes: VoteMap;
  /** 访客 IP 的 HMAC 前 16 位，只用于反刷与后台辨认同源刷屏；**不存明文 IP**。 */
  ipHash: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface PostRecord {
  id: string;
  /** URL 段，唯一，`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`。 */
  slug: string;
  title: string;
  /** `normalizeKey(title)`：搜索与稳定排序用。 */
  titleKey: string;
  /** Markdown 原文（上限 200 KB）。 */
  markdown: string;
  /**
   * 封面图 URL，只来自 `/api/admin/blog/media` 的上传结果。
   *
   * 空串 = 没有封面（**不从正文首图派生**：那会让「作者只想放一张装饰图」变成
   * 意外指定封面）。老 `blog.json` 里没有这个键，读的时候一律 `?? ''` 兜底。
   */
  coverImage: string;
  categoryId: string;
  /** 展示原值（首写者优先）。 */
  tags: string[];
  /** 与 `tags` 一一对应的正规化键，去重与筛选按它判。 */
  tagKeys: string[];
  author: AuthorSnapshot;
  status: PostStatus;
  /** 关闭回复：仍然可看、可投票，但发不了新回复。 */
  locked: boolean;
  votes: VoteMap;
  replies: ReplyRecord[];
  createdAt: string;
  updatedAt: string;
  /** 首次发布时间；下架不清空，重发不覆盖（「首次发布于」是有意义的信息）。 */
  publishedAt: string | null;
}

export interface CategoryRecord {
  id: string;
  name: string;
  /** `normalizeKey(name)`，唯一索引；改名不动帖子的 `categoryId`。 */
  key: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlogState {
  version: 1;
  updatedAt: string;
  posts: PostRecord[];
  categories: CategoryRecord[];
}

/* ---------------------------------------------------------------------------
   对外视图
--------------------------------------------------------------------------- */

/**
 * 读时回填用的「当前账号」快照。
 *
 * 由**路由层**用一次 `listUsers()` 建好传进来（不是每条回复各读一次 users.json），
 * store 自己不 import users 模块——两个 store 互相依赖会让队列边界变得难以推理。
 */
export interface LiveAuthor {
  nickname: string;
  avatarUrl: string;
  active: boolean;
  /** `role === 'owner' | 'admin'`，前端据此显示「站长」徽章。 */
  owner: boolean;
}

export type LiveAuthors = ReadonlyMap<string, LiveAuthor>;

export interface AuthorView {
  kind: AuthorKind;
  id: string;
  nickname: string;
  avatarUrl: string;
  /** 账号已注销 / 被停用：昵称仍显示当年的快照，另加一个灰标。 */
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
  /** 显式上传的封面；空串 = 没有封面。 */
  coverImage: string;
  category: { id: string; name: string } | null;
  tags: string[];
  author: AuthorView;
  score: number;
  up: number;
  down: number;
  replyCount: number;
  locked: boolean;
  /** 公开接口只会返回 `published`；管理接口用它区分草稿。 */
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
  /** 被隐藏的回复对外是空串（前端显示「该回复已删除」），楼层号照旧占位。 */
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

/* ---------------------------------------------------------------------------
   纯函数：派生值
--------------------------------------------------------------------------- */

/** 比较键的统一写法（与 `users/validate.ts` 的 `normalizeKey` 同义）。 */
export function normalizeKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tally(votes: VoteMap): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const value of Object.values(votes)) {
    if (value === 1) up += 1;
    else if (value === -1) down += 1;
  }
  return { up, down };
}

export function scoreOf(votes: VoteMap): number {
  let score = 0;
  for (const value of Object.values(votes)) score += value;
  return score;
}

export function myVoteOf(votes: VoteMap, viewerId: string | null): VoteValue {
  if (!viewerId) return 0;
  return votes[viewerId] ?? 0;
}

/** 列表页的「N 条回复」只数可见楼层。 */
export function replyCountOf(post: PostRecord): number {
  return post.replies.reduce((sum, reply) => (reply.status === 'visible' ? sum + 1 : sum), 0);
}

export function lastReplyAtOf(post: PostRecord): string | null {
  let latest: string | null = null;
  for (const reply of post.replies) {
    if (reply.status !== 'visible') continue;
    if (!latest || reply.createdAt > latest) latest = reply.createdAt;
  }
  return latest;
}

/**
 * 从 Markdown 抽一段纯文本摘要。
 *
 * 只给当页那 10 条算，所以不落盘（多存一份就等于把正文字节数翻倍）。代码块整块丢掉：
 * 摘要里出现一段代码既读不懂也占地方。
 */
export function excerptOf(markdown: string, max = 160): string {
  const text = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 按码点切，别把 emoji 的代理对切成半个字符。
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join('').trimEnd()}…` : text;
}

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

export function pickSummary(
  post: PostRecord,
  category: CategoryRecord | undefined,
  live: LiveAuthors,
  viewerId: string | null,
): PostSummary {
  const { up, down } = tally(post.votes);
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: excerptOf(post.markdown),
    // 老记录里没有这个键：不兜底的话 JSON 里会直接少一个字段，前端契约就断了。
    coverImage: post.coverImage ?? '',
    category: category ? { id: category.id, name: category.name } : null,
    tags: [...post.tags],
    author: authorView(post.author, live),
    score: up - down,
    up,
    down,
    replyCount: replyCountOf(post),
    locked: post.locked,
    status: post.status,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    publishedAt: post.publishedAt,
    lastReplyAt: lastReplyAtOf(post),
    myVote: myVoteOf(post.votes, viewerId),
  };
}

export function pickDetail(
  post: PostRecord,
  category: CategoryRecord | undefined,
  live: LiveAuthors,
  viewerId: string | null,
): PostDetail {
  return { ...pickSummary(post, category, live, viewerId), markdown: post.markdown };
}

/**
 * 单条回复的对外视图。
 *
 * `keepHiddenBody` 给管理后台用：站长需要看到被隐藏的楼层到底写了什么才谈得上复核；
 * 公开接口一律传 `false`，隐藏楼层的正文不出服务端。
 */
export function pickReply(
  reply: ReplyRecord,
  live: LiveAuthors,
  viewerId: string | null,
  keepHiddenBody = false,
): ReplyView {
  const { up, down } = tally(reply.votes);
  return {
    id: reply.id,
    floor: reply.floor,
    author: authorView(reply.author, live),
    body: reply.status === 'visible' || keepHiddenBody ? reply.body : '',
    replyToFloor: reply.replyToFloor,
    replyToName: reply.replyToName,
    score: up - down,
    up,
    down,
    myVote: myVoteOf(reply.votes, viewerId),
    status: reply.status,
    createdAt: reply.createdAt,
  };
}
