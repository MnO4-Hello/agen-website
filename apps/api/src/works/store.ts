/**
 * 作品的持久化层。
 *
 * **为什么是 JSON 文件而不是数据库**：这一站是单进程、单作者、作品量以「十几个」计的
 * 个人站点。引 sqlite/prisma 换来的只是构建复杂度；而一份 2MB 以内的 JSON 全量读进
 * 内存，读路径的延迟可以忽略。代价写在这里，别装作没有：
 *
 *   · **只支持单进程**。多个进程（cluster / 两份 dev server）指向同一个 data 目录会互相
 *     覆盖。真要横向扩，先换掉这一层。
 *   · **写入是整份重写**。所以有大小上限（见 validate.ts），也所以每次写之前留一份 `.bak`。
 *
 * 三条实现纪律：
 *
 *   1. **原子写**：写临时文件 → `fsync` → `rename`。中途断电只会留下一个 `.tmp`，
 *      `works.json` 要么是旧的、要么是新的，不会是一半。
 *   2. **串行队列**：所有「读-改-写」走同一条 Promise 链。并发保存两个作品时，
 *      不会出现后写的把先写的覆盖掉。
 *   3. **解析失败不静默重置**：`works.json` 坏了就报 500，让人去修。悄悄重置等于
 *      把作者的作品全部删掉，还告诉他一切正常。
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moveToTrash, trashStamp } from '../admin/trash.js';
import {
  hashedMediaName,
  mimeOfMediaName,
  sniffImage as sniffImageShared,
  type MediaExt,
} from '../media/sniff-image.js';
import {
  WorkError,
  parseWorkFields,
  resolveSlug,
  slugify,
} from './validate.js';
import {
  pickDetail,
  pickSummary,
  type WorkDetail,
  type WorkFields,
  type WorkRecord,
  type WorkSummary,
  type WorksState,
} from './types.js';

/**
 * `apps/api` 的绝对路径。
 *
 * 源码在 `src/works/store.ts`、编译在 `dist/works/store.js`，两者都往上两跳：
 * `works/` → `src|dist` → `api`。
 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DATA_DIR = path.join(API_ROOT, 'data');
const WORKS_FILE = path.join(DATA_DIR, 'works.json');
const MEDIA_DIR = path.join(DATA_DIR, 'works-media');

/** 媒体命名：`w-` + 内容 sha1 前 16 位 + 由 magic byte 决定的扩展名。 */
const MEDIA_RE = /^w-[a-f0-9]{16}\.(png|jpg|webp|gif|avif)$/;

/* ---------------------------------------------------------------------------
   目录与媒体路径
--------------------------------------------------------------------------- */

export const mediaPaths = {
  dir: MEDIA_DIR,
  file(name: string): string {
    return path.join(MEDIA_DIR, name);
  },
  /** 容器路径在这台机器上的真实路径（用来挡符号链接出逃）。 */
  async realDir(): Promise<string> {
    await mkdir(MEDIA_DIR, { recursive: true });
    return realpath(MEDIA_DIR);
  },
};

export function isMediaName(value: string): boolean {
  return MEDIA_RE.test(value);
}

export function mediaMime(name: string): string {
  return mimeOfMediaName(name);
}

/** 内容哈希命名的 URL → 文件名；不是本站命名就返回 null。 */
function mediaNameFromUrl(url: string): string | null {
  const prefix = '/api/works/media/';
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return MEDIA_RE.test(name) ? name : null;
}

/* ---------------------------------------------------------------------------
   串行队列与原子写
--------------------------------------------------------------------------- */

let chain: Promise<unknown> = Promise.resolve();

/**
 * 把任务排到队尾。
 *
 * `chain.then(task, task)` 是关键：前一个任务失败时也要继续跑下一个，否则一次校验
 * 失败会让整条队列永久卡死。`chain` 自身则被吞成 `undefined`，不让 rejection 泄漏
 * 成「未处理的 Promise 拒绝」。
 */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Windows 上 `rename` 偶尔会 EPERM（杀毒软件短暂占用目标文件），重试两次就过去了。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (attempt >= 2 || !retriable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

let sequence = 0;

/**
 * 整份落盘。
 *
 * 顺序：备份旧文件 → 写临时文件 → fsync → rename。`fsync` 不能省：没有它，
 * rename 之后断电仍可能得到「文件名在、内容空」的 0 字节文件。
 */
async function persist(state: WorksState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  // 上一版留档。第一次写入时文件还不存在，`copyFile` 会 ENOENT——忽略即可。
  await copyFile(WORKS_FILE, `${WORKS_FILE}.bak`).catch(() => undefined);

  const body = `${JSON.stringify(state, null, 2)}\n`;
  sequence += 1;
  const tmp = path.join(DATA_DIR, `.works.${process.pid}.${Date.now()}.${sequence}.tmp`);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, WORKS_FILE);
}

/* ---------------------------------------------------------------------------
   读取
--------------------------------------------------------------------------- */

function emptyState(): WorksState {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

function isRecord(value: unknown): value is WorkRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.slug === 'string';
}

async function readState(): Promise<WorksState> {
  let raw: string;
  try {
    raw = await readFile(WORKS_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const state = emptyState();
      await persist(state);
      return state;
    }
    throw new WorkError(500, `读取 works.json 失败：${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 绝不重置：那会把作者的作品全部清空，还显示一切正常。
    throw new WorkError(500, 'works.json 不是合法的 JSON，请先修好这个文件（同目录有 .bak）。');
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as WorksState).items)) {
    throw new WorkError(500, 'works.json 的结构不对：缺少 items 数组。');
  }

  // 逐条检查最小结构：与其带着一条残缺记录跑出各种 `undefined`，不如当场说清楚。
  const items = (parsed as WorksState).items;
  if (!items.every(isRecord)) {
    throw new WorkError(500, 'works.json 里有结构不对的记录（缺少 id 或 slug），请先修好。');
  }

  return parsed as WorksState;
}

const stamp = (): string => new Date().toISOString();

function fieldsOf(record: WorkRecord): WorkFields {
  return {
    mode: record.mode,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    year: record.year,
    category: record.category,
    repoUrl: record.repoUrl,
    demoUrl: record.demoUrl,
    thumbnail: record.thumbnail,
    gallery: record.gallery,
    readme: record.readme,
    html: record.html,
    published: record.published,
    order: record.order,
  };
}

const byOrder = (a: WorkRecord, b: WorkRecord): number => {
  if (a.order !== b.order) return a.order - b.order;
  // order 撞了就按更新时间倒序，再不行按 slug——保证排序是确定的。
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.slug < b.slug ? -1 : 1;
};

/* ---------------------------------------------------------------------------
   对外接口
--------------------------------------------------------------------------- */

/** 公开列表：只给已发布的，按 order 升序。 */
export function listPublished(): Promise<WorkSummary[]> {
  return exclusive(async () => {
    const state = await readState();
    return state.items
      .filter((item) => item.published)
      .sort(byOrder)
      .map(pickSummary);
  });
}

/** 管理列表：全部，含草稿。 */
export function listAll(): Promise<WorkRecord[]> {
  return exclusive(async () => {
    const state = await readState();
    return [...state.items].sort(byOrder);
  });
}

/** 公开详情：`published === false` 一律当作不存在（草稿不该被链接猜到）。 */
export function findPublished(slug: string): Promise<WorkDetail | null> {
  return exclusive(async () => {
    const state = await readState();
    const record = state.items.find((item) => item.slug === slug && item.published);
    return record ? pickDetail(record) : null;
  });
}

export function findById(id: string): Promise<WorkRecord | null> {
  return exclusive(async () => {
    const state = await readState();
    return state.items.find((item) => item.id === id) ?? null;
  });
}

/** 新建。`order` 缺省排到末尾。 */
export function createWork(body: unknown): Promise<WorkRecord> {
  return exclusive(async () => {
    const state = await readState();
    const fields = parseWorkFields(body, null);

    const taken = new Set(state.items.map((item) => item.slug));
    const ordered = (base: string): string => {
      if (!taken.has(base)) return base;
      for (let index = 2; index < 1000; index += 1) {
        const next = `${base}-${index}`;
        if (!taken.has(next)) return next;
      }
      return `${base}-${Date.now().toString(36)}`;
    };

    const rawSlug = (body as Record<string, unknown>).slug;
    const slug = resolveSlug(rawSlug, fields.title, null, taken, ordered);
    const now = stamp();
    const order =
      (body as Record<string, unknown>).order === undefined
        ? state.items.reduce((max, item) => Math.max(max, item.order), -1) + 1
        : fields.order;

    const record: WorkRecord = {
      ...fields,
      order,
      id: randomUUID(),
      slug,
      createdAt: now,
      updatedAt: now,
    };

    state.items.push(record);
    state.updatedAt = now;
    await persist(state);
    return record;
  });
}

export function updateWork(id: string, body: unknown): Promise<WorkRecord> {
  return exclusive(async () => {
    const state = await readState();
    const index = state.items.findIndex((item) => item.id === id);
    const current = state.items[index];
    if (!current) throw new WorkError(404, '没有这个作品，可能已经被删掉了。');

    const fields = parseWorkFields(body, fieldsOf(current));
    const taken = new Set(state.items.filter((item) => item.id !== id).map((item) => item.slug));
    const ordered = (base: string): string => {
      if (!taken.has(base)) return base;
      for (let next = 2; next < 1000; next += 1) {
        const candidate = `${base}-${next}`;
        if (!taken.has(candidate)) return candidate;
      }
      return `${base}-${Date.now().toString(36)}`;
    };

    const slug = resolveSlug(
      (body as Record<string, unknown>).slug,
      fields.title,
      current.slug,
      taken,
      ordered,
    );

    const next: WorkRecord = {
      ...current,
      ...fields,
      slug,
      updatedAt: stamp(),
    };

    state.items[index] = next;
    state.updatedAt = next.updatedAt;
    await persist(state);
    return next;
  });
}

export function setPublished(id: string, published: boolean): Promise<WorkRecord> {
  return updateWork(id, { published });
}

/**
 * 删除。
 *
 * 记录先摘掉、再落盘，最后才挪媒体——顺序反了的话，一旦落盘失败就会留下一批
 * 「记录还在、图没了」的空壳作品。媒体是否该挪，看的是**删除后还有没有被引用**。
 */
export function removeWork(id: string): Promise<{ trashedTo: string | null }> {
  return exclusive(async () => {
    const state = await readState();
    const target = state.items.find((item) => item.id === id);
    if (!target) throw new WorkError(404, '没有这个作品，可能已经被删掉了。');

    const remaining = state.items.filter((item) => item.id !== id);
    state.items = remaining;
    state.updatedAt = stamp();
    await persist(state);

    const stillUsed = new Set<string>();
    for (const item of remaining) {
      if (item.thumbnail) stillUsed.add(item.thumbnail);
      for (const shot of item.gallery) stillUsed.add(shot);
    }

    const candidates = new Set<string>();
    if (target.thumbnail) candidates.add(target.thumbnail);
    for (const shot of target.gallery) candidates.add(shot);

    const stampValue = trashStamp();
    let moved = 0;
    for (const url of candidates) {
      if (stillUsed.has(url)) continue;
      const name = mediaNameFromUrl(url);
      if (!name) continue;
      const result = await moveToTrash(mediaPaths.file(name), 'works-media', stampValue);
      if (result) moved += 1;
    }

    return { trashedTo: moved > 0 ? `.admin-trash/works-media/${stampValue}` : null };
  });
}

/** 按给定的 id 顺序重排。必须是全量置换，漏一条会让那条的 order 落在旧值上。 */
export function reorderWorks(ids: readonly string[]): Promise<WorkRecord[]> {
  return exclusive(async () => {
    const state = await readState();
    const currentIds = state.items.map((item) => item.id);
    if (ids.length !== currentIds.length) {
      throw new WorkError(409, '排序列表和现有作品数量不一致，请刷新后重试。');
    }
    const wanted = new Set(ids);
    if (wanted.size !== ids.length || !currentIds.every((id) => wanted.has(id))) {
      throw new WorkError(409, '排序列表和现有作品对不上（有重复或缺失），请刷新后重试。');
    }

    const now = stamp();
    const position = new Map(ids.map((id, index) => [id, index]));
    state.items = state.items.map((item) => {
      const order = position.get(item.id);
      if (order === undefined || order === item.order) return item;
      return { ...item, order, updatedAt: now };
    });
    state.updatedAt = now;
    await persist(state);
    return [...state.items].sort(byOrder);
  });
}

/* ---------------------------------------------------------------------------
   媒体
--------------------------------------------------------------------------- */

/**
 * 只认 magic byte，**不信客户端给的扩展名**。
 *
 * 判定逻辑住在 `../media/sniff-image.ts`——账号的头像/封面上传用的是同一份白名单，
 * 抄两份迟早会分叉（补白名单时漏掉一边，那一半就悄悄允许了不该允许的格式）。
 */
function sniffImage(buffer: Buffer): MediaExt | null {
  return sniffImageShared(buffer);
}

export interface SavedMedia {
  file: string;
  url: string;
  mime: string;
  size: number;
}

/**
 * 存一张图。
 *
 * 文件名 = 内容哈希：同一张图反复上传只占一份，URL 也因此可以放心用
 * `immutable` 长缓存（换图必换 URL，不会有「改了图但浏览器还显示旧的」）。
 */
export function saveMedia(buffer: Buffer): Promise<SavedMedia> {
  return exclusive(async () => {
    const ext = sniffImage(buffer);
    if (!ext) {
      throw new WorkError(415, '只支持 PNG / JPEG / WebP / GIF / AVIF 图片。');
    }

    await mkdir(MEDIA_DIR, { recursive: true });
    const file = hashedMediaName('w', buffer, ext);
    const target = mediaPaths.file(file);

    const exists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!exists) {
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, buffer);
      await renameWithRetry(tmp, target);
    }

    return { file, url: `/api/works/media/${file}`, mime: mimeOfMediaName(file), size: buffer.length };
  });
}

/** 给后台表单用：把「按标题重新生成 slug」的逻辑暴露出去（前端不自己实现）。 */
export function suggestSlug(title: string): string {
  return slugify(title);
}
