/**
 * DEV 截图用的假数据源（**只在 `import.meta.env.DEV` 下被动态 import**）。
 *
 * 生产构建里 `main.ts` 的那段 `if (false)` 会被整体摇掉，这个模块不会进 bundle；
 * 它的存在只为「改完 admin.css 打开 /admin.html?preview=console」能一眼看到真实布局，
 * 不需要起后端、也不需要登录。任何数据都不落盘。
 */

import type {
  AccountRole,
  AdminAccount,
  AdminAccountCaps,
  AdminAccountPage,
  AdminBadge,
  AdminMessage,
  AdminWork,
  ApiResult,
  BadgeDraft,
  FileEntry,
  FileListing,
  FileRoot,
  LogEntry,
  ServerStats,
  SiteModeSnapshot,
} from './api';
import { createAccountsView } from './views/accounts';
import { createBadgeCatalogView } from './views/badge-catalog';
import type { AccountSource } from './views/account-source';
import { createConsoleView, type ConsoleSource } from './views/console';
import { createFilesView, type FilesSource } from './views/files';
import { createGuestbookView, type GuestbookSource } from './views/guestbook';
import { createPostsView } from './views/posts';
import { createSettingsView } from './views/settings';
import { createWorksView, type WorksSource } from './views/works';
import type { PostsSource } from './views/post-source';
import type { SiteModeSource } from './site-source';
import type { AdminViewFactory, AdminViewId } from './views/shell';

const startedAt = Date.now() - 3 * 60 * 60 * 1000;

const STATS: ServerStats = {
  pid: 24816,
  node: 'v22.22.2',
  platform: 'win32/x64',
  startedAt,
  uptimeSeconds: 3 * 60 * 60 + 12 * 60,
  rssBytes: 78.4 * 1024 * 1024,
  heapUsedBytes: 21.7 * 1024 * 1024,
  logCount: 7,
};

let nextId = 1;

function line(level: LogEntry['level'], text: string, secondsAgo: number): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    time: Date.now() - secondsAgo * 1000,
    level,
    stream: level === 'error' ? 'stderr' : 'stdout',
    text,
  };
  return entry;
}

const SEED: LogEntry[] = [
  line('info', 'Server listening at http://0.0.0.0:3000', 300),
  line('info', 'incoming request · GET /api/health · → 200 · 2ms', 240),
  line('info', 'incoming request · GET /api/works · → 200 · 5ms', 180),
  line('warn', 'ADMIN_FILE_ROOTS 没配，使用默认的三处目录', 120),
  line('info', 'incoming request · POST /api/admin/login · → 200 · 41ms', 60),
  line('info', 'incoming request · GET /api/admin/console/stream · → 200 · 1ms', 30),
  line('error', 'Error: connect ECONNREFUSED 127.0.0.1:5432', 12),
];

const previewConsole: ConsoleSource = {
  snapshot: async (after): Promise<ApiResult<{ logs: LogEntry[]; stats: ServerStats }>> => ({
    ok: true,
    data: { logs: SEED.filter((entry) => entry.id > after), stats: STATS },
  }),
  clear: async (): Promise<ApiResult<unknown>> => ({ ok: true, data: { ok: true } }),
  subscribe: (after, handlers) => {
    let timer = 0;
    let alive = true;
    const open = window.setTimeout(() => {
      if (alive) handlers.onState('open');
    }, 30);
    const messages: Array<[LogEntry['level'], string]> = [
      ['info', 'incoming request · GET /api/admin/files/list · → 200 · 3ms'],
      ['info', 'incoming request · GET /api/health · → 200 · 1ms'],
      ['warn', 'request timed out after 8000ms · GET /api/works'],
      ['info', 'incoming request · GET /api/admin/console/logs · → 200 · 2ms'],
    ];
    let cursor = 0;
    timer = window.setInterval(() => {
      if (!alive) return;
      const [level, text] = messages[cursor % messages.length];
      cursor += 1;
      handlers.onLog(line(level, text, 0));
    }, 2400);
    // `after` 在预览里没用（快照本来就是空的），保留参数只为签名一致。
    void after;
    return () => {
      alive = false;
      window.clearTimeout(open);
      window.clearInterval(timer);
    };
  },
};

const PREVIEW_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#bfe0c6"/><stop offset="1" stop-color="#e8d3a8"/>' +
      '</linearGradient></defs><rect width="320" height="200" fill="url(#g)"/>' +
      '<text x="160" y="106" font-family="system-ui" font-size="14" fill="#1f3d2b" text-anchor="middle">preview.png</text></svg>',
  );

const ROOTS: FileRoot[] = [
  { path: 'apps/web/public', label: '站点资源', exists: true },
  { path: 'shots', label: '截图', exists: true },
  { path: 'services', label: '服务文档', exists: true },
];

function entry(name: string, kind: FileEntry['kind'], size: number, minutesAgo: number): FileEntry {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  const image = ['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(ext);
  return {
    name,
    path: name,
    kind,
    size,
    mtime: Date.now() - minutesAgo * 60 * 1000,
    mime: image ? `image/${ext}` : null,
    preview: kind === 'dir' ? 'other' : image ? 'image' : ['md', 'ts', 'json', 'css', 'html'].includes(ext) ? 'text' : 'other',
  };
}

const LISTINGS: Record<string, FileEntry[]> = {
  '': [
    entry('images', 'dir', 0, 42),
    entry('skills', 'dir', 0, 120),
    entry('fonts', 'dir', 0, 300),
    entry('portrait-1024.png', 'file', 184320, 8),
    entry('portrait-512.png', 'file', 51200, 9),
    entry('favicon.svg', 'file', 1180, 2600),
    entry('notes.md', 'file', 3420, 1200),
  ],
  images: [
    entry('hero.jpg', 'file', 421000, 60),
    entry('work-01.png', 'file', 268000, 90),
  ],
};

const SAMPLE_TEXT = `# 站点资源目录

图片放在 \`images/\`，字体放在 \`fonts/\`，技能场景用的小图标在 \`skills/\`。

- 上传时保持文件名语义化（\`hero-2026.jpg\` 而不是 \`IMG_0042.jpg\`）
- 大图先压到 200 KB 以内，再放进 public
- 删除会先移到 \`.admin-trash/\`，确认无误后再手动清

> 这个预览用的是假数据，任何改动都不会落盘。
`;

const previewFiles: FilesSource = {  roots: async () => ({ ok: true, data: { roots: ROOTS } }),
  list: async (root, path): Promise<ApiResult<FileListing>> => ({
    ok: true,
    data: {
      root,
      path,
      parent: path ? path.split('/').slice(0, -1).join('/') : null,
      entries: LISTINGS[path] ?? [],
    },
  }),
  read: async (root, path) => ({
    ok: true,
    data: { root, path, size: SAMPLE_TEXT.length, mtime: Date.now() - 600000, binary: false, truncated: false, text: SAMPLE_TEXT },
  }),
  save: async () => ({ ok: true, data: { ok: true, size: 0, mtime: Date.now() } }),
  upload: async () => ({ ok: true, data: { ok: true, path: '', size: 0, mtime: Date.now() } }),
  mkdir: async () => ({ ok: true, data: { ok: true, path: '' } }),
  rename: async () => ({ ok: true, data: { ok: true, path: '' } }),
  remove: async () => ({ ok: true, data: { ok: true, trashedTo: '.admin-trash/demo', message: '' } }),
  rawUrl: () => PREVIEW_IMAGE,
};

/* ---------------------------------------------------------------------------
   作品（`?preview=works`）
--------------------------------------------------------------------------- */

/** 一条假作品。时间戳固定，预览不会因为「刚更新」而每次看起来不一样。 */
function work(
  id: string,
  slug: string,
  title: string,
  extra: Partial<AdminWork> = {},
): AdminWork {
  const stamp = '2026-10-12T09:20:00.000Z';
  return {
    id,
    slug,
    mode: 'template',
    title,
    summary: '一句话简介：它是什么、解决了什么问题。',
    tags: ['TypeScript', 'Vite'],
    year: '2026',
    category: 'Web',
    repoUrl: 'https://github.com/example/repo',
    demoUrl: '',
    thumbnail: PREVIEW_IMAGE,
    gallery: [],
    readme: '# 说明\n\n假数据，不会落盘。',
    html: '',
    published: true,
    order: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

const PREVIEW_WORKS: AdminWork[] = [
  work('w1', 'personal-site', '个人站点 2026', { order: 0 }),
  work('w2', 'pixel-playground', '像素游乐场', {
    order: 1,
    mode: 'developer',
    summary: '一整个自己写的 Canvas 页面，塞进沙箱 iframe 里跑。',
    tags: ['Canvas', 'WebGL'],
    readme: '',
    html: '<!doctype html><h1 style="font:600 24px system-ui;padding:24px">Hello</h1>',
    published: false,
  }),
  work('w3', 'toolbox', '小工具集合', {
    order: 2,
    category: '工具',
    tags: ['Node'],
    thumbnail: '',
  }),
];

const previewWorks: WorksSource = {
  list: async () => ({ ok: true, data: { works: PREVIEW_WORKS.map((item) => ({ ...item })) } }),
  create: async () => ({ ok: true, data: { work: PREVIEW_WORKS[0] as AdminWork } }),
  update: async (_id, input) => ({
    ok: true,
    data: { work: { ...(PREVIEW_WORKS[0] as AdminWork), ...input, updatedAt: new Date().toISOString() } },
  }),
  remove: async () => ({ ok: true, data: { ok: true, trashedTo: '.admin-trash/works-media/demo' } }),
  publish: async (id, published) => {
    const found = PREVIEW_WORKS.find((item) => item.id === id) ?? (PREVIEW_WORKS[0] as AdminWork);
    return { ok: true, data: { work: { ...found, published } } };
  },
  reorder: async (ids) => ({
    ok: true,
    data: {
      works: ids
        .map((id, index) => {
          const found = PREVIEW_WORKS.find((item) => item.id === id);
          return found ? { ...found, order: index } : null;
        })
        .filter((item): item is AdminWork => item !== null),
    },
  }),
  upload: async () => ({
    ok: true,
    data: { file: 'preview.png', url: PREVIEW_IMAGE, mime: 'image/png', size: 1024 },
  }),
};

/* ---------------------------------------------------------------------------
   帖子（内容）
--------------------------------------------------------------------------- */

const PREVIEW_AUTHOR = { kind: 'admin' as const, id: '', nickname: '阿根', avatarUrl: '' };

const previewPostsData = [
  {
    id: 'post-1',
    slug: 'why-no-framework',
    title: '为什么整站不用框架',
    markdown: '# 起因\n\n一个个人站点，页面不到十页，**引框架的收益全在熟悉度上**，成本却要摊在构建与调试里。\n\n## 取舍\n\n- 路由是自己写的哈希表，五十行\n- 正文渲染器一百多行，直接产出节点树\n\n> 少一个依赖，就少一类注入面。',
    coverImage: PREVIEW_IMAGE,
    categoryId: 'cat-1',
    tags: ['折腾', '记录'],
    author: PREVIEW_AUTHOR,
    status: 'published' as const,
    locked: false,
    up: 12,
    down: 1,
    score: 11,
    replyCount: 3,
    createdAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
    publishedAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
  },
  {
    id: 'post-2',
    slug: 'captcha-notes',
    title: '免登录回复为什么要做人机验证',
    markdown: '游客没有身份，能依赖的只有 IP 与题目。\n\n所以验证题必须是**一次性**的：答对就销毁。',
    coverImage: '',
    categoryId: 'cat-2',
    tags: ['安全'],
    author: PREVIEW_AUTHOR,
    status: 'published' as const,
    locked: true,
    up: 5,
    down: 0,
    score: 5,
    replyCount: 1,
    createdAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    publishedAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
  },
  {
    id: 'post-3',
    slug: 'draft-example',
    title: '还没写完的一篇（草稿）',
    markdown: '这一段只有后台看得到。',
    coverImage: '',
    categoryId: 'cat-1',
    tags: [],
    author: PREVIEW_AUTHOR,
    status: 'draft' as const,
    locked: false,
    up: 0,
    down: 0,
    score: 0,
    replyCount: 0,
    createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    publishedAt: null,
  },
];

const previewCategories = [
  { id: 'cat-1', name: '技术', key: '技术', order: 0, count: 2 },
  { id: 'cat-2', name: '随笔', key: '随笔', order: 1, count: 1 },
  { id: 'cat-3', name: '问答', key: '问答', order: 2, count: 0 },
];

const previewReplies = [1, 2, 3].map((floor) => ({
  id: `reply-${floor}`,
  floor,
  author:
    floor === 2
      ? { kind: 'user' as const, id: 'u1', nickname: '林一', avatarUrl: '', owner: false }
      : { kind: 'guest' as const, id: '', nickname: '游客', avatarUrl: '' },
  body:
    floor === 1
      ? '第一楼：这个结构读起来比一堆卡片舒服。'
      : floor === 2
        ? '第二楼：站长亲自回复一下这个问题。'
        : '第三楼：赞同按一次就够了，再按一次是取消。',
  replyToFloor: floor === 3 ? 1 : null,
  replyToName: floor === 3 ? '游客' : '',
  score: floor,
  up: floor,
  down: 0,
  status: 'visible' as const,
  createdAt: new Date(Date.now() - (4 - floor) * 1800 * 1000).toISOString(),
}));

const previewPosts: PostsSource = {
  meta: async () => ({
    ok: true,
    data: { author: { nickname: '阿根', avatarUrl: '' }, categories: previewCategories },
  }),
  list: async (query) => ({
    ok: true,
    data: {
      posts: previewPostsData.filter(
        (post) =>
          (!query.status || post.status === query.status) &&
          (!query.cat || post.categoryId === query.cat) &&
          (!query.q || post.title.includes(query.q)),
      ),
    },
  }),
  get: async (id) => {
    const found = previewPostsData.find((post) => post.id === id);
    return found ? { ok: true, data: { post: found } } : { ok: false, status: 404, message: '没有这篇帖子。' };
  },
  create: async (input) => ({
    ok: true,
    data: {
      post: {
        ...previewPostsData[0]!,
        id: `post-${Date.now()}`,
        slug: 'preview-new',
        title: input.title,
        markdown: input.markdown,
        categoryId: input.categoryId,
        tags: input.tags,
        status: input.status,
        locked: input.locked,
      },
    },
  }),
  update: async (id, input) => {
    const found = previewPostsData.find((post) => post.id === id) ?? previewPostsData[0]!;
    return { ok: true, data: { post: { ...found, ...input, slug: input.slug || found.slug } } };
  },
  setStatus: async (id, status) => {
    const found = previewPostsData.find((post) => post.id === id) ?? previewPostsData[0]!;
    return { ok: true, data: { post: { ...found, status } } };
  },
  remove: async () => ({ ok: true, data: { ok: true, removedReplies: 3 } }),
  replies: async () => ({ ok: true, data: { replies: previewReplies, nextCursor: null } }),
  setReplyStatus: async (id, status) => {
    const found = previewReplies.find((reply) => reply.id === id) ?? previewReplies[0]!;
    return { ok: true, data: { reply: { ...found, status } } };
  },
  uploadMedia: async () => ({
    ok: true,
    // 预览模式不连后端，给一个内联 SVG 让缩略图有东西可看。
    data: {
      file: 'preview.png',
      url:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="#dcecd7"/><text x="80" y="55" font-size="14" text-anchor="middle" fill="#3f7d58">预览图</text></svg>',
        ),
      mime: 'image/svg+xml',
      size: 512,
    },
  }),
  categories: async () => ({ ok: true, data: { categories: previewCategories } }),
  createCategory: async (name) => ({
    ok: true,
    data: { category: { id: `cat-${Date.now()}`, name, key: name, order: 9, count: 0 } },
  }),
  updateCategory: async (id, name) => {
    const found = previewCategories.find((category) => category.id === id) ?? previewCategories[0]!;
    return { ok: true, data: { category: { ...found, name, key: name } } };
  },
  removeCategory: async () => ({
    ok: false,
    status: 409,
    message: '这个分类下还有 2 篇帖子，先把它们改到别的分类再删。',
  }),
  reorderCategories: async () => ({ ok: true, data: { categories: previewCategories } }),
};

/* ---------- 留言（假数据） ---------- */

const PREVIEW_AUTHOR_GUEST = {
  kind: 'guest' as const,
  id: '',
  nickname: '游客',
  avatarUrl: '',
  deleted: false,
  owner: false,
};

const PREVIEW_AUTHOR_OWNER = {
  kind: 'admin' as const,
  id: '',
  nickname: '阿根',
  avatarUrl: '',
  deleted: false,
  owner: true,
};

function previewMessage(over: Partial<AdminMessage> & Pick<AdminMessage, 'id' | 'body'>): AdminMessage {
  return {
    floor: 1,
    author: PREVIEW_AUTHOR_GUEST,
    mode: 'text',
    images: [],
    status: 'visible',
    createdAt: new Date(startedAt + 3600_000).toISOString(),
    replies: [],
    replyCount: 0,
    ...over,
  };
}

const previewMessages: AdminMessage[] = [
  previewMessage({
    id: 'p1',
    floor: 3,
    body: '## 一个 Markdown 留言\n\n- 列表第一项\n- 列表第二项\n\n**加粗**与[外链](https://example.com)',
    mode: 'markdown',
    status: 'hidden',
  }),
  previewMessage({
    id: 'p2',
    floor: 2,
    body: '带两张图的留言，用来检查缩略图网格与「已隐藏」的虚线底。',
    images: ['/portrait-512.png'],
    replies: [
      previewMessage({
        id: 'p2r1',
        floor: null,
        author: PREVIEW_AUTHOR_OWNER,
        body: '站长回复：收到，谢谢留言。',
        createdAt: new Date(startedAt + 3700_000).toISOString(),
      }),
      previewMessage({
        id: 'p2r2',
        floor: null,
        body: '一条被隐藏的回复。',
        status: 'hidden',
        createdAt: new Date(startedAt + 3800_000).toISOString(),
      }),
    ],
    replyCount: 1,
  }),
  previewMessage({
    id: 'p3',
    floor: 1,
    body: '最简单的纯文本留言。',
    replies: [
      previewMessage({
        id: 'p3r1',
        floor: null,
        author: PREVIEW_AUTHOR_OWNER,
        body: '站长回复，默认展开可见。',
        createdAt: new Date(startedAt + 3900_000).toISOString(),
      }),
    ],
    replyCount: 1,
  }),
];

const previewGuestbook: GuestbookSource = {
  list: async () => ({
    ok: true,
    data: { messages: previewMessages, nextCursor: null, total: previewMessages.length },
  }),
  setStatus: async (id, status) => {
    const found = previewMessages.find((message) => message.id === id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这条。' };
    found.status = status;
    return { ok: true, data: { message: found } };
  },
  // 预览模式不真的写数据：回一句人话就够看板面了。
  reply: async () => ({ ok: false, status: 400, message: '预览模式不会真的写数据。' }),
};

/* ---------------------------------------------------------------------------
   账户与徽章（`?preview=accounts` / `?preview=badges`）
---------------------------------------------------------------------------

   假数据要覆盖到「每一种状态」才有意义：正常、禁言中、封禁中、已过期、
   自己（按钮全灰）。否则截图里永远只看到最顺利的那一栏。
*/

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

const CAPS_ALL: AdminAccountCaps = {
  role: true,
  ban: true,
  mute: true,
  grantBadge: true,
  grantOwner: true,
  revokeBadge: true,
};

/** 操作自己：改角色 / 封禁 / 禁言全灰，徽章仍可发（站长能给自己挂徽章）。 */
const CAPS_SELF: AdminAccountCaps = {
  role: false,
  ban: false,
  mute: false,
  grantBadge: true,
  grantOwner: false,
  revokeBadge: true,
};

const previewBadges: AdminBadge[] = [
  {
    id: 'g-early001',
    label: '早期贡献者',
    color: '#2f6244',
    emoji: '🎖',
    hint: '站点还很空的时候就在这里',
    order: 1,
    createdAt: ago(86400 * 40),
    createdBy: 'admin',
    archivedAt: null,
    grantCount: 2,
  },
  {
    id: 'g-writer01',
    label: '笔杆子',
    color: '#4c6f8a',
    emoji: '✒️',
    hint: '写过被很多人收藏的帖子',
    order: 2,
    createdAt: ago(86400 * 12),
    createdBy: 'admin',
    archivedAt: null,
    grantCount: 1,
  },
  {
    id: 'g-beta0001',
    label: '内测成员',
    color: '#7d6a3f',
    emoji: '⚑',
    hint: '参与过内测',
    order: 3,
    createdAt: ago(86400 * 90),
    createdBy: 'admin',
    archivedAt: ago(86400 * 5),
    grantCount: 0,
  },
];

function previewAccount(input: {
  username: string;
  nickname: string;
  role: AccountRole;
  email?: string;
  can?: AdminAccountCaps;
  ban?: AdminAccount['ban'];
  mute?: AdminAccount['mute'];
  badges?: AdminAccount['grantedBadges'];
  lastLogin?: string | null;
}): AdminAccount {
  return {
    id: `u-${input.username}`,
    username: input.username,
    nickname: input.nickname,
    email: input.email ?? `${input.username}@example.com`,
    role: input.role,
    legacyDisabled: false,
    createdAt: ago(86400 * 120),
    lastLoginAt: input.lastLogin === undefined ? ago(3600 * 5) : input.lastLogin,
    ban: input.ban ?? null,
    mute: input.mute ?? null,
    grantedBadges: input.badges ?? [],
    can: input.can ?? CAPS_ALL,
  };
}

const PREVIEW_EARLY = {
  badgeId: 'g-early001',
  label: '早期贡献者',
  color: '#2f6244',
  emoji: '🎖',
  hint: '站点还很空的时候就在这里',
  grantedAt: ago(86400 * 30),
  archived: false,
};

const previewAccounts: AdminAccount[] = [
  previewAccount({
    username: 'MnO4_',
    nickname: '阿根',
    role: 'owner',
    email: 'owner@example.com',
    can: CAPS_SELF,
    badges: [PREVIEW_EARLY],
    lastLogin: ago(1800),
  }),
  previewAccount({
    username: 'ache',
    nickname: '阿澈',
    role: 'admin',
    badges: [
      {
        badgeId: 'g-writer01',
        label: '笔杆子',
        color: '#4c6f8a',
        emoji: '✒️',
        hint: '写过被很多人收藏的帖子',
        grantedAt: ago(86400 * 6),
        archived: false,
      },
    ],
  }),
  previewAccount({
    username: 'xiaoman',
    nickname: '小满',
    role: 'user',
    mute: {
      until: new Date(Date.now() + 86400 * 5 * 1000).toISOString(),
      reason: '在留言板连续刷屏',
      by: '阿澈',
      bySource: 'account',
      at: ago(86400 * 2),
      active: true,
    },
  }),
  previewAccount({
    username: 'cat',
    nickname: '路过的猫',
    role: 'user',
    ban: {
      until: new Date(Date.now() + 86400 * 26 * 1000).toISOString(),
      reason: '发布广告链接',
      by: 'admin',
      bySource: 'env',
      at: ago(86400 * 4),
      active: true,
    },
  }),
  previewAccount({
    username: 'newbie',
    nickname: '刚注册的人',
    role: 'user',
    lastLogin: null,
    ban: {
      until: ago(86400 * 1),
      reason: '测试用的旧记录（已过期）',
      by: 'admin',
      bySource: 'env',
      at: ago(86400 * 8),
      active: false,
    },
  }),
];

function previewPage(): AdminAccountPage {
  return {
    accounts: previewAccounts,
    total: previewAccounts.length,
    page: 1,
    size: 20,
    counts: {
      total: previewAccounts.length,
      owners: previewAccounts.filter((item) => item.role === 'owner').length,
      admins: previewAccounts.filter((item) => item.role === 'admin').length,
      banned: previewAccounts.filter((item) => item.ban?.active).length,
      muted: previewAccounts.filter((item) => item.mute?.active).length,
    },
  };
}

function findPreviewAccount(id: string): AdminAccount | null {
  return previewAccounts.find((item) => item.id === id) ?? null;
}

const okAccount = (account: AdminAccount): ApiResult<{ account: AdminAccount }> => ({
  ok: true,
  data: { account },
});

/**
 * 预览数据源：所有操作都只改内存，**绝不发请求**。
 *
 * 列表筛选（搜索 / 角色 / 状态）在预览里不生效——这层只为「看版面」，
 * 真要验证筛选逻辑得连后端。写在这里免得以后有人以为是 bug。
 */
const previewAccountSource: AccountSource = {
  list: async () => ({ ok: true, data: previewPage() }),
  setRole: async (id, role) => {
    const found = findPreviewAccount(id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这个人。' };
    found.role = role;
    return okAccount(found);
  },
  ban: async (id, days, reason) => {
    const found = findPreviewAccount(id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这个人。' };
    found.ban = {
      until: days === 0 ? null : new Date(Date.now() + days * 86400_000).toISOString(),
      reason,
      by: 'admin',
      bySource: 'env',
      at: new Date().toISOString(),
      active: true,
    };
    return okAccount(found);
  },
  unban: async (id) => {
    const found = findPreviewAccount(id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这个人。' };
    found.ban = null;
    return okAccount(found);
  },
  mute: async (id, days, reason) => {
    const found = findPreviewAccount(id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这个人。' };
    found.mute = {
      until: days === 0 ? null : new Date(Date.now() + days * 86400_000).toISOString(),
      reason,
      by: 'admin',
      bySource: 'env',
      at: new Date().toISOString(),
      active: true,
    };
    return okAccount(found);
  },
  unmute: async (id) => {
    const found = findPreviewAccount(id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这个人。' };
    found.mute = null;
    return okAccount(found);
  },
  catalog: async () => ({
    ok: true,
    data: {
      badges: previewBadges.filter((item) => item.archivedAt === null),
      archived: previewBadges.filter((item) => item.archivedAt !== null),
    },
  }),
  createBadge: async (draft: BadgeDraft) => {
    const badge: AdminBadge = {
      id: `g-preview${previewBadges.length}`,
      label: draft.label,
      color: draft.color,
      emoji: draft.emoji,
      hint: draft.hint || '由站长授予',
      order: previewBadges.length + 1,
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
      archivedAt: null,
      grantCount: 0,
    };
    previewBadges.push(badge);
    return { ok: true, data: { badge } };
  },
  updateBadge: async (id, draft) => {
    const found = previewBadges.find((item) => item.id === id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这枚徽章。' };
    Object.assign(found, { ...draft, hint: draft.hint || '由站长授予' });
    return { ok: true, data: { badge: found } };
  },
  archiveBadge: async (id) => {
    const found = previewBadges.find((item) => item.id === id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这枚徽章。' };
    found.archivedAt = new Date().toISOString();
    return { ok: true, data: { badge: found, affectedGrants: found.grantCount } };
  },
  restoreBadge: async (id) => {
    const found = previewBadges.find((item) => item.id === id);
    if (!found) return { ok: false, status: 404, message: '预览里没有这枚徽章。' };
    found.archivedAt = null;
    return { ok: true, data: { badge: found, affectedGrants: found.grantCount } };
  },
  grant: async (userId, badgeId) => {
    const account = findPreviewAccount(userId);
    const badge = previewBadges.find((item) => item.id === badgeId);
    if (!account || !badge) return { ok: false, status: 404, message: '预览里没有这条数据。' };
    if (!account.grantedBadges.some((item) => item.badgeId === badgeId)) {
      account.grantedBadges.push({
        badgeId: badge.id,
        label: badge.label,
        color: badge.color,
        emoji: badge.emoji,
        hint: badge.hint,
        grantedAt: new Date().toISOString(),
        archived: badge.archivedAt !== null,
      });
    }
    return okAccount(account);
  },
  revoke: async (userId, badgeId) => {
    const account = findPreviewAccount(userId);
    if (!account) return { ok: false, status: 404, message: '预览里没有这个人。' };
    account.grantedBadges = account.grantedBadges.filter((item) => item.badgeId !== badgeId);
    return okAccount(account);
  },
};

const previewSiteMode: SiteModeSnapshot = {
  mode: 'display',
  features: { blog: false, message: false, account: false, profiles: false },
  source: 'file',
  envMode: 'display',
  updatedAt: new Date(Date.now() - 26 * 60 * 1000).toISOString(),
  updatedBy: '阿根',
  corrupt: false,
};

export function createPreviewViews(
  view:
    | 'console'
    | 'files'
    | 'works'
    | 'content'
    | 'guestbook'
    | 'accounts'
    | 'badges'
    | 'settings',
): Partial<Record<AdminViewId, AdminViewFactory>> {
  if (view === 'settings') {
    /*
     * `?preview=settings&state=corrupt`：看一眼「存储文件损坏」时的提示块。
     * 假数据源不写盘——write 一律回 `changed: false`，截图通道不该有副作用。
     */
    const corrupt = new URLSearchParams(location.search).get('state') === 'corrupt';
    const site: SiteModeSnapshot = corrupt
      ? {
          ...previewSiteMode,
          mode: 'display',
          source: 'fallback',
          corrupt: true,
          updatedAt: null,
          updatedBy: null,
        }
      : previewSiteMode;
    const source: SiteModeSource = {
      read: async () => ({ ok: true, data: { site } }),
      write: async () => ({ ok: true, data: { site, changed: false } }),
    };
    return { settings: () => createSettingsView(source) };
  }

  if (view === 'console') return { console: () => createConsoleView(previewConsole) };
  if (view === 'accounts') {
    // `?preview=accounts&open=2`：自动展开第 2 行的面板，方便截图看操作区。
    const open = Number(new URLSearchParams(location.search).get('open'));
    if (Number.isInteger(open) && open > 0) {
      window.setTimeout(() => {
        const row = document.querySelectorAll<HTMLElement>('.acm__row')[open - 1];
        row?.querySelector<HTMLElement>('.acm__ops .admin-btn')?.click();
      }, 300);
    }
    return { accounts: () => createAccountsView(previewAccountSource) };
  }
  if (view === 'badges') return { badges: () => createBadgeCatalogView(previewAccountSource) };
  if (view === 'content') {
    const edit = new URLSearchParams(location.search).get('edit');
    if (edit) {
      // `?preview=content&edit=1`：自动点开第一篇，方便截图看编辑器版面。
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('.bps__row-title')?.click();
      }, 300);
    }
    return { content: () => createPostsView(previewPosts) };
  }
  if (view === 'guestbook') {
    // `?preview=guestbook&open=2`：自动展开第 2 条，方便截图看详情块。
    const open = Number(new URLSearchParams(location.search).get('open'));
    if (Number.isInteger(open) && open > 0) {
      window.setTimeout(() => {
        const row = document.querySelectorAll<HTMLElement>('.gbk__row')[open - 1];
        row?.querySelector<HTMLElement>('.gbk__ops .admin-btn')?.click();
      }, 300);
    }
    return { guestbook: () => createGuestbookView(previewGuestbook) };
  }
  if (view === 'works') {
    // `?preview=works&edit=<slug>`：自动打开某条作品的编辑器，方便截图看版面。
    const target = new URLSearchParams(location.search).get('edit');
    if (target) {
      window.setTimeout(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.wks__row')].find((node) =>
          node.querySelector('.wks__slug')?.textContent?.includes(target),
        );
        const edit = [...(row?.querySelectorAll<HTMLElement>('button') ?? [])].find(
          (button) => button.textContent?.includes('编辑'),
        );
        edit?.click();
      }, 250);
    }
    return { works: () => createWorksView(previewWorks) };
  }

  // `?preview=files&open=notes.md`：自动点开一个文件，方便截图看预览/编辑器版面。
  const open = new URLSearchParams(location.search).get('open');
  if (open) {
    window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>('.files__name')].find((node) =>
        node.textContent?.includes(open),
      );
      target?.click();
    }, 250);
  }
  return { files: () => createFilesView(previewFiles) };
}
