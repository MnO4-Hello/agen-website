/**
 * 管理后台「文件管理」接口。
 *
 * 这个接口能删能写——所以安全边界必须是**白名单**，不是黑名单：
 *
 *   1. **只有 `ADMIN_FILE_ROOTS` 里列出的目录可以被访问**（默认 `站点资源` / `截图` /
 *      `服务文档` 三个）。客户端传的是「根目录的相对路径 + 根内相对路径」，服务端自己拼
 *      绝对路径，所以客户端根本没法指定任意盘符。
 *   2. **逐段归一化**：`..`、空段、绝对路径、NUL 一律拒绝；拼完再用 `realpath` 复核一次，
 *      防止通过符号链接溜到白名单外面（符号链接本身也不允许读写）。
 *   3. **删除不是 `rm`，是移动到 `.admin-trash/<时间戳>/…`**：误删可以从磁盘上找回来，
 *      而且跨设备/文件被占用时 `rename` 会失败而不是删掉一半。
 *   4. **大小上限**：预览 256 KB、保存 1 MB、上传 25 MB。管理后台不需要拖几个 G 的东西。
 *
 * 这些规则都写在 `resolveTarget()` 一个地方，新增路由时复用它，别再各自拼路径。
 */

import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireAdmin } from '../admin/session.js';

/** 仓库根（`apps/api/src/routes/` 往上四层；编译到 `dist/routes/` 后层数相同）。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 误删文件的回收站。和源码同盘，所以 `rename` 是原子操作。 */
const TRASH_DIR = path.join(REPO_ROOT, '.admin-trash');

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_SAVE_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface FileRoot {
  /** 相对仓库根的 posix 路径，同时充当接口里的 `root` 参数。 */
  path: string;
  label: string;
}

/**
 * 默认允许管理的目录。
 *
 * `apps/web/public` 放站点资源（图、字体），`shots` 是本地截图，`services` 是各语言服务
 * 的说明——这三处是「改了不用重新编译、但也别乱动」的典型。要加目录请改 `.env` 的
 * `ADMIN_FILE_ROOTS`（格式：`名称=相对路径`，逗号分隔），别在这里堆。
 */
const DEFAULT_ROOTS: FileRoot[] = [
  { path: 'apps/web/public', label: '站点资源' },
  { path: 'shots', label: '截图' },
  { path: 'services', label: '服务文档' },
];

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts',
  'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'conf', 'env', 'log', 'csv', 'tsv', 'sh', 'bat', 'ps1', 'py', 'java', 'go',
  'rs', 'c', 'h', 'cpp', 'hpp', 'sql', 'gitignore', 'editorconfig',
]);

type EntryKind = 'file' | 'dir' | 'symlink' | 'other';
type PreviewKind = 'text' | 'image' | 'other';

class FileError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'FileError';
  }
}

function extOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext;
}

/** 文件名是否有扩展名意义：`.env` 这种点开头无扩展名的也算「无扩展名」。 */
function mimeOf(name: string): string | null {
  return MIME_BY_EXT[extOf(name)] ?? null;
}

function previewOf(name: string): PreviewKind {
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return 'text';
  const mime = mimeOf(name);
  if (mime?.startsWith('image/')) return 'image';
  return 'other';
}

function posix(value: string): string {
  return value.split(path.sep).join('/');
}

function trimSlashes(value: string): string {
  return value.replace(/^\.?\//, '').replace(/\/+$/, '');
}

/**
 * 归一化「根内相对路径」。空字符串代表根目录本身。
 *
 * 只允许 `a/b/c` 这种形式：绝对路径、盘符、`..`、NUL、控制字符全部拒绝——**不做**「尽力
 * 修正」，因为修正过的路径和用户看到的不是一回事，反而更难解释。
 */
function normalizeRel(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new FileError(400, '路径参数格式不对。');
  if (value.includes('\0')) throw new FileError(400, '路径里不能有控制字符。');

  const cleaned = trimSlashes(value.replace(/\\/g, '/'));
  if (cleaned === '') return '';

  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new FileError(400, '路径不能跳出所在目录。');
    if (/[\u0000-\u001f<>:"|?*]/.test(segment)) throw new FileError(400, `路径里有非法字符：${segment}`);
  }
  return segments.filter((segment) => segment && segment !== '.').join('/');
}

/** 单段名字（新建 / 重命名 / 上传）的校验，比整条路径更严：连 `/` 都不许有。 */
function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new FileError(400, '缺少名称。');
  const name = value.trim();
  if (!name) throw new FileError(400, '名称不能为空。');
  if (name === '.' || name === '..') throw new FileError(400, '这个名称不能用。');
  if (name.length > 120) throw new FileError(400, '名称太长了（最多 120 个字符）。');
  if (/[\\/\u0000-\u001f<>:"|?*]/.test(name)) throw new FileError(400, '名称里不能有这些字符：\\ / : * ? " < > |');
  if (/[. ]$/.test(name)) throw new FileError(400, '名称结尾不能是点或空格（Windows 会自己去掉，容易对不上）。');
  // Windows 保留设备名。
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new FileError(400, '这是 Windows 的保留名称，换个名字。');
  }
  return name;
}

/**
 * 读白名单。环境变量格式：`名称=相对路径,名称=相对路径`，省略名称就用目录名。
 *
 * 只收仓库内的相对路径：绝对路径（或 `..` 开头）会让「白名单」变成「全盘」，直接忽略并
 * 在启动日志里说一声太吵，这里选择静默丢弃——配置错误表现为「看不到这个根」，足够明显。
 */
function readRoots(): FileRoot[] {
  const raw = process.env.ADMIN_FILE_ROOTS?.trim();
  if (!raw) return DEFAULT_ROOTS;

  const roots: FileRoot[] = [];
  raw.split(',').forEach((chunk, index) => {
    const item = chunk.trim();
    if (!item) return;
    const eq = item.lastIndexOf('=');
    const label = eq > 0 ? item.slice(0, eq).trim() : '';
    const relPath = posix((eq > 0 ? item.slice(eq + 1) : item).trim());
    if (!relPath || path.isAbsolute(relPath) || relPath.split('/').includes('..')) return;
    const cleaned = trimSlashes(relPath);
    if (!cleaned) return;
    roots.push({ path: cleaned, label: label || path.basename(cleaned) || `目录 ${index + 1}` });
  });
  return roots.length > 0 ? roots : DEFAULT_ROOTS;
}

interface ResolvedRoot extends FileRoot {
  dir: string;
}

function findRoot(value: unknown): ResolvedRoot {
  const wanted = posix(typeof value === 'string' ? value : '');
  const root = readRoots().find((item) => item.path === trimSlashes(wanted));
  if (!root) throw new FileError(400, '没有这个目录根（或它不在允许列表里）。');
  return { ...root, dir: path.join(REPO_ROOT, ...root.path.split('/')) };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把「根 + 相对路径」解析成绝对路径，并做两道防线。
 *
 * 第一道是纯字符串的（`normalizeRel` + `path.join`），第二道是 `realpath`——后者才挡得住
 * 符号链接：目录本身在白名单里，但子目录是软链到 `C:\Windows` 的情况。
 */
async function resolveTarget(root: ResolvedRoot, relRaw: unknown): Promise<{ abs: string; rel: string }> {
  if (!(await exists(root.dir))) throw new FileError(404, `目录还不存在：${root.path}`);

  const rel = normalizeRel(relRaw);
  const abs = rel ? path.join(root.dir, ...rel.split('/')) : root.dir;

  const realRoot = await realpath(root.dir);
  let probe = abs;
  try {
    probe = await realpath(abs);
  } catch {
    // 目标还不存在（新建/上传）：检查它的父目录是不是仍在根内。
    probe = await realpath(path.dirname(abs));
    if (probe !== realRoot && !probe.startsWith(realRoot + path.sep)) {
      throw new FileError(403, '路径越出了允许的目录。');
    }
    return { abs, rel };
  }

  if (probe !== realRoot && !probe.startsWith(realRoot + path.sep)) {
    throw new FileError(403, '路径越出了允许的目录（可能是符号链接）。');
  }
  return { abs, rel };
}

interface Entry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
  mime: string | null;
  preview: PreviewKind;
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FileError) {
    return reply.code(error.statusCode).send({ error: 'file_error', message: error.message });
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return reply.code(404).send({ error: 'file_error', message: '文件或目录不存在。' });
  if (code === 'EACCES' || code === 'EPERM') {
    return reply.code(403).send({ error: 'file_error', message: '没有权限操作这个文件。' });
  }
  if (code === 'EEXIST') return reply.code(409).send({ error: 'file_error', message: '同名文件已经存在。' });
  return reply.code(500).send({
    error: 'file_error',
    message: `操作失败：${error instanceof Error ? error.message : String(error)}`,
  });
}

function isBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
}

export async function adminFileRoutes(app: FastifyInstance): Promise<void> {
  // 上传走裸二进制 body（前端 `fetch(url, { body: file })` 就是 `application/octet-stream`），
  // 不引 multipart：一个文件一个请求，够用且少一层解析。
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /** 可管理的根目录列表（前端左侧的根切换）。 */
  app.get('/admin/files/roots', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const roots = await Promise.all(
      readRoots().map(async (root) => ({
        path: root.path,
        label: root.label,
        exists: await exists(path.join(REPO_ROOT, ...root.path.split('/'))),
      })),
    );
    return reply.send({ roots });
  });

  /** 列目录。`path` 为空表示根目录。 */
  app.get('/admin/files/list', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const query = request.query as Record<string, unknown>;
      const root = findRoot(query.root);
      const { abs, rel } = await resolveTarget(root, query.path);

      const stats = await stat(abs);
      if (!stats.isDirectory()) throw new FileError(400, '这不是一个目录。');

      const dirents = await readdir(abs, { withFileTypes: true });
      const entries: Entry[] = [];

      for (const dirent of dirents) {
        const childAbs = path.join(abs, dirent.name);
        let childStats;
        try {
          childStats = await stat(childAbs);
        } catch {
          continue; // 列目录时文件被删了：跳过，别让整页 500。
        }
        const kind: EntryKind = dirent.isSymbolicLink()
          ? 'symlink'
          : childStats.isDirectory()
            ? 'dir'
            : childStats.isFile()
              ? 'file'
              : 'other';
        entries.push({
          name: dirent.name,
          path: joinRel(rel, dirent.name),
          kind,
          size: kind === 'file' ? childStats.size : 0,
          mtime: childStats.mtimeMs,
          mime: kind === 'file' ? mimeOf(dirent.name) : null,
          preview: kind === 'file' ? previewOf(dirent.name) : 'other',
        });
      }

      entries.sort((a, b) => {
        const aDir = a.kind === 'dir' ? 0 : 1;
        const bDir = b.kind === 'dir' ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
      });

      return reply.send({ root: root.path, path: rel, parent: rel ? rel.split('/').slice(0, -1).join('/') : null, entries });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 读文本文件（预览/编辑用）。二进制只回元信息，内容走 `/raw`。 */
  app.get('/admin/files/read', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const query = request.query as Record<string, unknown>;
      const root = findRoot(query.root);
      const { abs, rel } = await resolveTarget(root, query.path);

      const stats = await stat(abs);
      if (!stats.isFile()) throw new FileError(400, '这不是一个文件。');

      const length = Math.min(stats.size, MAX_PREVIEW_BYTES);
      const buffer = Buffer.alloc(length);
      const handle = await open(abs, 'r');
      try {
        if (length > 0) await handle.read(buffer, 0, length, 0);
      } finally {
        await handle.close();
      }

      // 前 8 KB 里出现 NUL 就当二进制（足够识别图片/压缩包，也不会误判 UTF-16 以外的小文本）。
      const binary = buffer.subarray(0, 8192).includes(0);
      return reply.send({
        root: root.path,
        path: rel,
        size: stats.size,
        mtime: stats.mtimeMs,
        binary,
        truncated: stats.size > length,
        text: binary ? null : buffer.toString('utf8'),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 原文件输出（图片预览、下载）。`download=1` 时改成附件。 */
  app.get('/admin/files/raw', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const query = request.query as Record<string, unknown>;
      const root = findRoot(query.root);
      const { abs } = await resolveTarget(root, query.path);
      const stats = await stat(abs);
      if (!stats.isFile()) throw new FileError(400, '这不是一个文件。');

      const name = path.basename(abs);
      const type = mimeOf(name) ?? 'application/octet-stream';
      const disposition = query.download === '1' ? 'attachment' : 'inline';
      reply.header('content-type', extOf(name) === 'svg' ? `${type}; charset=utf-8` : type);
      reply.header('content-length', String(stats.size));
      reply.header(
        'content-disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      // 这些是**私有**文件，中间代理绝不能缓存。
      reply.header('cache-control', 'private, no-store');
      return reply.send(createReadStream(abs));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 保存文本内容（编辑器）。允许新建文件。 */
  app.post('/admin/files/save', { bodyLimit: MAX_SAVE_BYTES + 64 * 1024 }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new FileError(400, '请求体格式不对。');
      const content = body.content;
      if (typeof content !== 'string') throw new FileError(400, '缺 content。');
      if (Buffer.byteLength(content, 'utf8') > MAX_SAVE_BYTES) {
        throw new FileError(413, '文件太大（编辑上限 1 MB），请用下载/上传替换。');
      }

      const root = findRoot(body.root);
      const { abs, rel } = await resolveTarget(root, body.path);
      if (!rel) throw new FileError(400, '要指定文件名。');
      const stats0 = await stat(abs).catch(() => null);
      if (stats0?.isDirectory()) throw new FileError(400, '不能把目录当文件写。');

      await writeFile(abs, content, 'utf8');
      const stats = await stat(abs);
      return reply.send({ ok: true, size: stats.size, mtime: stats.mtimeMs });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 上传一个文件。默认不覆盖（`overwrite=1` 才覆盖），避免手滑盖掉同名资源。 */
  app.post('/admin/files/upload', { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const query = request.query as Record<string, unknown>;
      const name = normalizeName(query.name);
      if (!isBuffer(request.body) || request.body.length === 0) {
        throw new FileError(400, '没有收到文件内容。');
      }
      if (request.body.length > MAX_UPLOAD_BYTES) throw new FileError(413, '文件超过 25 MB。');

      const root = findRoot(query.root);
      const dir = await resolveTarget(root, query.path);
      const targetRel = joinRel(dir.rel, name);
      const target = await resolveTarget(root, targetRel);

      if ((await exists(target.abs)) && query.overwrite !== '1') {
        throw new FileError(409, '同名文件已经存在。');
      }
      await writeFile(target.abs, request.body);
      const stats = await stat(target.abs);
      return reply.send({ ok: true, path: targetRel, size: stats.size, mtime: stats.mtimeMs });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 新建文件夹。 */
  app.post('/admin/files/mkdir', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new FileError(400, '请求体格式不对。');
      const name = normalizeName(body.name);
      const root = findRoot(body.root);
      const parent = await resolveTarget(root, body.path);
      const targetRel = joinRel(parent.rel, name);
      const target = await resolveTarget(root, targetRel);

      if (await exists(target.abs)) throw new FileError(409, '同名的文件夹或文件已经存在。');
      await mkdir(target.abs);
      return reply.send({ ok: true, path: targetRel });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** 重命名（同一目录内）。 */
  app.post('/admin/files/rename', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new FileError(400, '请求体格式不对。');
      const name = normalizeName(body.name);
      const root = findRoot(body.root);
      const from = await resolveTarget(root, body.path);
      if (!from.rel) throw new FileError(400, '不能重命名根目录。');

      const parentRel = from.rel.split('/').slice(0, -1).join('/');
      const targetRel = joinRel(parentRel, name);
      const to = await resolveTarget(root, targetRel);
      if (to.abs === from.abs) return reply.send({ ok: true, path: targetRel });
      if (await exists(to.abs)) throw new FileError(409, '同名文件已经存在。');

      await rename(from.abs, to.abs);
      return reply.send({ ok: true, path: targetRel });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * 删除 = 移到回收站。
   *
   * 真正删盘需要用户到 `.admin-trash` 手动清，这是故意的：管理后台点错一次不该是
   * 不可逆事故。目录也是整体 `rename` 过去，不会删一半。
   */
  app.post('/admin/files/remove', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') throw new FileError(400, '请求体格式不对。');
      const root = findRoot(body.root);
      const target = await resolveTarget(root, body.path);
      if (!target.rel) throw new FileError(400, '不能删除根目录。');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let destination = path.join(TRASH_DIR, stamp, ...root.path.split('/'), ...target.rel.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      if (await exists(destination)) destination = `${destination}-${Date.now().toString(36)}`;

      await rename(target.abs, destination);
      return reply.send({
        ok: true,
        trashedTo: posix(path.relative(REPO_ROOT, destination)),
        message: '已移到 .admin-trash，需要彻底删除请手动清理该目录。',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
