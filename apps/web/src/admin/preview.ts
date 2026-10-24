/**
 * DEV 截图用的假数据源（**只在 `import.meta.env.DEV` 下被动态 import**）。
 *
 * 生产构建里 `main.ts` 的那段 `if (false)` 会被整体摇掉，这个模块不会进 bundle；
 * 它的存在只为「改完 admin.css 打开 /admin.html?preview=console」能一眼看到真实布局，
 * 不需要起后端、也不需要登录。任何数据都不落盘。
 */

import type { AdminWork, ApiResult, FileEntry, FileListing, FileRoot, LogEntry, ServerStats } from './api';
import { createConsoleView, type ConsoleSource } from './views/console';
import { createFilesView, type FilesSource } from './views/files';
import { createWorksView, type WorksSource } from './views/works';
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

export function createPreviewViews(
  view: 'console' | 'files' | 'works',
): Partial<Record<AdminViewId, AdminViewFactory>> {
  if (view === 'console') return { console: () => createConsoleView(previewConsole) };
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
