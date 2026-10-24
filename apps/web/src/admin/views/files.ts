/**
 * 文件管理视图。
 *
 * 能做的事：浏览白名单目录、预览文本/图片、编辑保存文本、上传、新建文件夹、重命名、删除
 * （删除 = 移到仓库根的 `.admin-trash/`，不是真删）。
 *
 * 三条前端纪律：
 *   1. **文件名/内容一律 `textContent`**：这些东西来自磁盘，可能带 `<script>`。
 *   2. **切换文件前先问脏状态**：编辑器里有没保存的改动时，`confirm` 之后再走。
 *   3. **大文件只预览不可编辑**：后端预览截断在 256 KB，若允许保存就等于把文件截断——
 *      所以 `truncated` 时文本框只读、保存禁用。
 */

import {
  createFolder,
  fetchFileRoots,
  listFiles,
  rawFileUrl,
  readFileContent,
  removeEntry,
  renameEntry,
  saveFileContent,
  uploadFile,
  type ApiResult,
  type FileContent,
  type FileEntry,
  type FileListing,
  type FileRoot,
} from '../api';
import { button, el, formatBytes, formatDateTime, icon, type IconName } from '../ui';
import type { AdminView } from './view';

export interface FilesSource {
  roots: () => Promise<ApiResult<{ roots: FileRoot[] }>>;
  list: (root: string, path: string) => Promise<ApiResult<FileListing>>;
  read: (root: string, path: string) => Promise<ApiResult<FileContent>>;
  save: (root: string, path: string, content: string) => Promise<ApiResult<{ ok: boolean; size: number; mtime: number }>>;
  upload: (
    root: string,
    path: string,
    file: File,
    overwrite?: boolean,
  ) => Promise<ApiResult<{ ok: boolean; path: string; size: number; mtime: number }>>;
  mkdir: (root: string, path: string, name: string) => Promise<ApiResult<{ ok: boolean; path: string }>>;
  rename: (root: string, path: string, name: string) => Promise<ApiResult<{ ok: boolean; path: string }>>;
  remove: (root: string, path: string) => Promise<ApiResult<{ ok: boolean; trashedTo: string; message: string }>>;
  rawUrl: (root: string, path: string, download?: boolean) => string;
}

const liveSource: FilesSource = {
  roots: fetchFileRoots,
  list: listFiles,
  read: readFileContent,
  save: saveFileContent,
  upload: uploadFile,
  mkdir: createFolder,
  rename: renameEntry,
  remove: removeEntry,
  rawUrl: rawFileUrl,
};

const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'html', 'py', 'java', 'go', 'sh', 'sql']);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function iconFor(entry: FileEntry): IconName {
  if (entry.kind === 'dir') return 'folder';
  if (entry.preview === 'image') return 'image';
  if (CODE_EXTS.has(extOf(entry.name))) return 'code';
  return 'file';
}

function kindLabel(entry: FileEntry): string {
  if (entry.kind === 'dir') return '文件夹';
  if (entry.kind === 'symlink') return '符号链接（不跟随）';
  if (entry.preview === 'image') return '图片';
  if (entry.preview === 'text') return '文本';
  return '二进制文件';
}

export function createFilesView(source: FilesSource = liveSource): AdminView {
  let roots: FileRoot[] = [];
  let rootPath = '';
  let cwd = '';
  let entries: FileEntry[] = [];
  let selected: FileEntry | null = null;
  let closed = false;
  let loading = false;

  /** 编辑器状态（只有文本预览会用到）。 */
  let editor: HTMLTextAreaElement | null = null;
  let savedText = '';
  let dirty = false;
  let readOnly = false;

  let statusTimer = 0;
  let previewToken = 0;

  /* ---- 骨架 ---- */

  const rootChips = el('div', { className: 'files__roots' });

  const uploadInput = el('input', {
    className: 'files__fileinput',
    attrs: { type: 'file', multiple: true, 'aria-hidden': 'true', tabindex: '-1' },
  }) as HTMLInputElement;

  const uploadButton = button({
    className: 'admin-btn admin-btn--primary',
    icon: 'upload',
    text: '上传',
    title: '上传到当前目录',
    onClick: () => uploadInput.click(),
  });

  const newFolderButton = button({
    className: 'admin-btn',
    icon: 'plus',
    text: '新建文件夹',
    onClick: () => toggleNewFolder(true),
  });

  const refreshButton = button({
    className: 'admin-btn',
    icon: 'refresh',
    text: '刷新',
    onClick: () => void reload(),
  });

  const bar = el('div', { className: 'files__bar' }, [
    rootChips,
    el('div', { className: 'files__actions' }, [uploadButton, newFolderButton, refreshButton, uploadInput]),
  ]);

  const crumb = el('div', { className: 'files__crumb' });
  const rows = el('div', { className: 'files__rows', attrs: { role: 'list' } });
  const listEmpty = el('div', { className: 'files__empty', attrs: { hidden: true } });

  const newFolderInput = el('input', {
    className: 'admin-input',
    attrs: { type: 'text', placeholder: '文件夹名称', 'aria-label': '新文件夹名称' },
  }) as HTMLInputElement;

  const newFolderForm = el('form', { className: 'files__newfolder', attrs: { hidden: true } }, [
    newFolderInput,
    el('button', { className: 'admin-btn admin-btn--primary', attrs: { type: 'submit' }, text: '创建' }),
    button({ className: 'admin-btn', text: '取消', onClick: () => toggleNewFolder(false) }),
  ]);

  const listHead = el('div', { className: 'files__row files__row--head' }, [
    el('span', { text: '名称' }),
    el('span', { className: 'files__col-size', text: '大小' }),
    el('span', { className: 'files__col-time', text: '修改时间' }),
    el('span', { className: 'files__col-ops', text: '' }),
  ]);

  const dropHint = el('div', { className: 'files__drop', text: '松手即上传到当前目录' });

  const listPane = el('div', { className: 'files__listpane' }, [
    newFolderForm,
    listHead,
    rows,
    listEmpty,
    dropHint,
  ]);

  const preview = el('aside', { className: 'files__preview', attrs: { hidden: true } });

  const body = el('div', { className: 'files__body' }, [listPane, preview]);

  const status = el('p', { className: 'files__status', attrs: { role: 'status', 'aria-live': 'polite' } });

  const element = el('section', { className: 'files' }, [bar, crumb, body, status]);

  /* ---- 状态提示 ---- */

  function setStatus(message: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    status.textContent = message;
    status.className = `files__status${tone === 'info' ? '' : ` is-${tone}`}`;
    if (statusTimer) window.clearTimeout(statusTimer);
    if (message && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        if (status.textContent === message) {
          status.textContent = '';
          status.className = 'files__status';
        }
      }, 6000);
    }
  }

  /* ---- 数据 ---- */

  async function bootstrap(): Promise<void> {
    setStatus('正在读取目录列表…');
    const result = await source.roots();
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    roots = result.data.roots;
    renderRoots();

    const first = roots.find((root) => root.exists) ?? roots[0];
    if (!first) {
      listEmpty.textContent = '后端没有配置任何可管理的目录（ADMIN_FILE_ROOTS 为空）。';
      setStatus('');
      return;
    }
    rootPath = first.path;
    cwd = '';
    renderRoots();
    await reload();
  }

  /**
   * 重新列目录。
   *
   * `silent = true` 时不改底部状态行——保存/删除/上传这类操作自己会说「已保存 xxx」，
   * 如果这里再写一句「共 N 项」，用户就看不到刚才到底成功没有（这是实测踩到的）。
   */
  async function reload(silent = false): Promise<void> {
    if (!rootPath || closed || loading) return;
    loading = true;
    if (!silent) setStatus('读取中…');
    const result = await source.list(rootPath, cwd);
    loading = false;
    if (closed) return;

    if (!result.ok) {
      entries = [];
      rows.replaceChildren();
      listEmpty.hidden = false;
      listEmpty.textContent = result.message;
      setStatus(result.message, 'error');
      return;
    }

    entries = result.data.entries;
    renderCrumb();
    renderRows();
    if (!silent) setStatus(entries.length > 0 ? `共 ${entries.length} 项` : '这个目录是空的');
  }

  /* ---- 左侧根 ---- */

  function renderRoots(): void {
    rootChips.replaceChildren();
    for (const root of roots) {
      const chip = button({
        className: `files__root${root.path === rootPath ? ' is-active' : ''}`,
        text: root.label,
        title: root.exists ? root.path : `${root.path}（目录不存在）`,
        disabled: !root.exists,
        onClick: () => {
          if (root.path === rootPath) return;
          if (!confirmDiscard()) return;
          rootPath = root.path;
          cwd = '';
          selected = null;
          closePreview();
          renderRoots();
          void reload();
        },
      });
      rootChips.append(chip);
    }
  }

  /* ---- 面包屑 ---- */

  function renderCrumb(): void {
    crumb.replaceChildren();
    const root = roots.find((item) => item.path === rootPath);

    const up = button({
      className: 'admin-iconbtn',
      title: '上一级',
      icon: 'chevron',
      disabled: !cwd,
      onClick: () => {
        if (!cwd || !confirmDiscard()) return;
        cwd = cwd.split('/').slice(0, -1).join('/');
        selected = null;
        closePreview();
        void reload();
      },
    });
    up.classList.add('files__up');
    // 图标本身是向右的箭头，转 180° 当「返回上一级」用。
    crumb.append(up);

    const rootCrumb = el('button', {
      className: 'files__crumbitem',
      text: root?.label ?? rootPath,
      attrs: { type: 'button' },
    });
    rootCrumb.addEventListener('click', () => {
      if (!cwd || !confirmDiscard()) return;
      cwd = '';
      selected = null;
      closePreview();
      void reload();
    });
    crumb.append(rootCrumb);

    if (!cwd) return;
    const segments = cwd.split('/');
    let accumulated = '';
    segments.forEach((segment, index) => {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const target = accumulated;
      const isLast = index === segments.length - 1;
      crumb.append(el('span', { className: 'files__crumbsep' }, [icon('chevron', 12)]));
      const item = el('button', {
        className: `files__crumbitem${isLast ? ' is-current' : ''}`,
        text: segment,
        attrs: { type: 'button' },
      });
      item.addEventListener('click', () => {
        if (isLast || !confirmDiscard()) return;
        cwd = target;
        selected = null;
        closePreview();
        void reload();
      });
      crumb.append(item);
    });
  }

  /* ---- 列表 ---- */

  function renderRows(): void {
    rows.replaceChildren();
    listEmpty.hidden = entries.length > 0;
    if (entries.length === 0) {
      listEmpty.textContent = '这个目录是空的。可以把文件拖进来，或者点右上角「上传」。';
      return;
    }

    for (const entry of entries) {
      const row = el('div', {
        className: `files__row${selected?.path === entry.path ? ' is-selected' : ''}${entry.kind === 'dir' ? ' is-dir' : ''}`,
        attrs: { role: 'listitem' },
      });

      const name = el('button', {
        className: 'files__name',
        attrs: { type: 'button', title: entry.path || entry.name },
      });
      name.append(
        el('span', { className: 'files__icon' }, [icon(iconFor(entry), 18)]),
        el('span', { className: 'files__nametext', text: entry.name }),
      );
      if (entry.kind === 'symlink') name.append(el('span', { className: 'files__flag', text: '链接' }));
      name.addEventListener('click', () => {
        if (entry.kind === 'dir') {
          if (!confirmDiscard()) return;
          cwd = entry.path;
          selected = null;
          closePreview();
          void reload();
          return;
        }
        void selectEntry(entry);
      });

      const size = el('span', { className: 'files__col-size', text: entry.kind === 'dir' ? '—' : formatBytes(entry.size) });
      const time = el('span', { className: 'files__col-time', text: formatDateTime(entry.mtime) });

      const ops = el('span', { className: 'files__col-ops' });
      if (entry.kind === 'file') {
        const download = el('a', {
          className: 'admin-iconbtn',
          attrs: {
            href: source.rawUrl(rootPath, entry.path, true),
            title: `下载 ${entry.name}`,
            'aria-label': `下载 ${entry.name}`,
          },
        });
        download.append(icon('download', 15));
        ops.append(download);
      }
      ops.append(
        button({
          className: 'admin-iconbtn',
          icon: 'pencil',
          title: '重命名',
          onClick: () => void doRename(entry),
        }),
        button({
          className: 'admin-iconbtn admin-iconbtn--danger',
          icon: 'trash',
          title: '删除（移到回收站）',
          onClick: () => void doRemove(entry),
        }),
      );

      row.append(name, size, time, ops);
      rows.append(row);
    }
  }

  /* ---- 预览 ---- */

  function confirmDiscard(): boolean {
    if (!dirty) return true;
    return window.confirm('当前文件有未保存的修改，切换后会丢掉。继续？');
  }

  function closePreview(): void {
    preview.hidden = true;
    preview.replaceChildren();
    element.classList.remove('has-preview');
    editor = null;
    savedText = '';
    dirty = false;
    readOnly = false;
    if (selected) {
      selected = null;
      renderRows();
    }
  }

  function updateSaveState(): void {
    if (!editor) return;
    const saveButton = preview.querySelector<HTMLButtonElement>('[data-role="save"]');
    if (!saveButton) return;
    dirty = editor.value !== savedText;
    saveButton.disabled = readOnly || !dirty;
    saveButton.classList.toggle('is-active', dirty);
    const hint = preview.querySelector<HTMLElement>('[data-role="dirty"]');
    if (hint) {
      hint.textContent = readOnly ? '只读' : dirty ? '未保存' : '已保存';
      hint.className = `preview__badge${dirty ? ' is-dirty' : ''}`;
    }
  }

  async function selectEntry(entry: FileEntry): Promise<void> {
    if (!confirmDiscard()) return;
    selected = entry;
    renderRows();
    await showPreview(entry);
  }

  async function showPreview(entry: FileEntry): Promise<void> {
    const token = ++previewToken;
    editor = null;
    dirty = false;
    savedText = '';
    readOnly = false;

    preview.hidden = false;
    element.classList.add('has-preview');
    preview.replaceChildren(
      el('div', { className: 'preview__head' }, [
        el('div', { className: 'preview__title' }, [
          el('span', { className: 'files__icon' }, [icon(iconFor(entry), 18)]),
          el('span', { className: 'preview__name', text: entry.name }),
        ]),
        (() => {
          const close = button({
            className: 'admin-iconbtn',
            icon: 'close',
            title: '关闭预览',
            onClick: () => {
              if (!confirmDiscard()) return;
              closePreview();
            },
          });
          return close;
        })(),
      ]),
      el('p', { className: 'preview__meta', text: `${kindLabel(entry)} · ${formatBytes(entry.size)} · ${formatDateTime(entry.mtime)}` }),
      el('p', { className: 'preview__loading', text: '读取中…' }),
    );

    const footer = el('div', { className: 'preview__foot' });
    const download = el('a', {
      className: 'admin-btn',
      attrs: {
        href: source.rawUrl(rootPath, entry.path, true),
        title: '下载原文件',
      },
    });
    download.append(icon('download', 16), el('span', { text: '下载' }));
    footer.append(download);
    preview.append(footer);

    if (entry.kind !== 'file') {
      preview.querySelector('.preview__loading')?.remove();
      preview.append(el('p', { className: 'preview__note', text: '这是文件夹或特殊文件，选中它不会显示内容。' }));
      return;
    }

    if (entry.preview === 'image') {
      preview.querySelector('.preview__loading')?.remove();
      const img = el('img', {
        className: 'preview__image',
        attrs: { src: source.rawUrl(rootPath, entry.path), alt: entry.name, loading: 'lazy' },
      });
      img.addEventListener('error', () => {
        img.replaceWith(el('p', { className: 'preview__note is-error', text: '图片加载失败，可能不是有效的图片文件。' }));
      });
      preview.insertBefore(img, footer);
      return;
    }

    if (entry.preview !== 'text') {
      preview.querySelector('.preview__loading')?.remove();
      preview.insertBefore(
        el('p', { className: 'preview__note', text: '二进制文件不支持在线预览，需要时请下载后打开。' }),
        footer,
      );
      return;
    }

    const result = await source.read(rootPath, entry.path);
    if (closed || token !== previewToken) return;
    preview.querySelector('.preview__loading')?.remove();

    if (!result.ok) {
      preview.insertBefore(el('p', { className: 'preview__note is-error', text: result.message }), footer);
      return;
    }

    const content = result.data;
    readOnly = content.binary || content.truncated;
    savedText = content.text ?? '';

    editor = el('textarea', {
      className: 'preview__editor',
      attrs: {
        spellcheck: 'false',
        wrap: 'off',
        'aria-label': `${entry.name} 内容`,
        readonly: readOnly ? true : null,
      },
    }) as HTMLTextAreaElement;
    editor.value = savedText;

    if (content.truncated) {
      preview.insertBefore(
        el('p', {
          className: 'preview__note is-warn',
          text: `文件有 ${formatBytes(content.size)}，这里只显示前 256 KB。为避免把文件截断，编辑已禁用——请下载后用上传替换。`,
        }),
        footer,
      );
    } else if (content.binary) {
      preview.insertBefore(el('p', { className: 'preview__note', text: '检测到二进制内容，不支持编辑。' }), footer);
    }

    editor.addEventListener('input', updateSaveState);
    editor.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent();
      }
    });

    preview.insertBefore(editor, footer);

    const badge = el('span', { className: 'preview__badge', text: readOnly ? '只读' : '已保存', attrs: { 'data-role': 'dirty' } });
    const saveButton = button({
      className: 'admin-btn admin-btn--primary',
      icon: 'save',
      text: '保存',
      title: '保存（Ctrl+S）',
      disabled: true,
      onClick: () => void saveCurrent(),
    });
    saveButton.dataset.role = 'save';
    footer.append(badge, saveButton);
    updateSaveState();
  }

  async function saveCurrent(): Promise<void> {
    if (!editor || !selected || readOnly) return;
    const saveButton = preview.querySelector<HTMLButtonElement>('[data-role="save"]');
    if (saveButton) saveButton.disabled = true;

    const value = editor.value;
    const result = await source.save(rootPath, selected.path, value);
    if (closed) return;
    if (!result.ok) {
      setStatus(`保存失败：${result.message}`, 'error');
      if (saveButton) saveButton.disabled = false;
      return;
    }

    savedText = value;
    updateSaveState();
    setStatus(`已保存 ${selected.name}（${formatBytes(result.data.size)}）`, 'ok');
    // 列表上的修改时间/大小要跟着变；silent 是为了别把「已保存」这句盖掉。
    const currentPath = selected.path;
    await reload(true);
    const fresh = entries.find((entry) => entry.path === currentPath);
    if (fresh && selected) selected = fresh;
  }

  /* ---- 创建 / 重命名 / 删除 / 上传 ---- */

  function toggleNewFolder(show: boolean): void {
    newFolderForm.hidden = !show;
    if (show) {
      newFolderInput.value = '';
      newFolderInput.focus();
      return;
    }
    newFolderInput.value = '';
  }

  newFolderForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = newFolderInput.value.trim();
    if (!name) {
      newFolderInput.focus();
      return;
    }
    void source.mkdir(rootPath, cwd, name).then((result) => {
      if (closed) return;
      if (!result.ok) {
        setStatus(`新建失败：${result.message}`, 'error');
        return;
      }
      toggleNewFolder(false);
      setStatus(`已创建 ${name}`, 'ok');
      void reload(true);
    });
  });

  newFolderInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleNewFolder(false);
  });

  async function doRename(entry: FileEntry): Promise<void> {
    if (selected?.path === entry.path && dirty) {
      const proceed = window.confirm('编辑器里有未保存的修改，重命名会关闭预览并丢掉修改。继续？');
      if (!proceed) return;
    }
    const next = window.prompt(`把「${entry.name}」改名为：`, entry.name);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === entry.name) return;

    const result = await source.rename(rootPath, entry.path, name);
    if (closed) return;
    if (!result.ok) {
      setStatus(`重命名失败：${result.message}`, 'error');
      return;
    }
    if (selected?.path === entry.path) {
      dirty = false;
      closePreview();
    }
    setStatus(`已改名为 ${name}`, 'ok');
    await reload(true);
  }

  async function doRemove(entry: FileEntry): Promise<void> {
    const isDir = entry.kind === 'dir';
    const confirmed = window.confirm(
      `删除${isDir ? '文件夹' : '文件'}「${entry.name}」？\n\n它会被移到仓库根的 .admin-trash/，需要时可以从磁盘找回来。`,
    );
    if (!confirmed) return;

    const result = await source.remove(rootPath, entry.path);
    if (closed) return;
    if (!result.ok) {
      setStatus(`删除失败：${result.message}`, 'error');
      return;
    }
    if (selected?.path === entry.path) {
      dirty = false;
      closePreview();
    }
    setStatus(`已移到 ${result.data.trashedTo}`, 'ok');
    await reload(true);
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (list.length === 0) return;

    let done = 0;
    for (const file of list) {
      setStatus(`正在上传 ${file.name}（${formatBytes(file.size)}）…`);
      let result = await source.upload(rootPath, cwd, file, false);
      if (!result.ok && result.status === 409) {
        if (window.confirm(`「${file.name}」已经存在，覆盖它？`)) {
          result = await source.upload(rootPath, cwd, file, true);
        } else {
          continue;
        }
      }
      if (!result.ok) {
        setStatus(`上传 ${file.name} 失败：${result.message}`, 'error');
        return;
      }
      done += 1;
    }

    if (done > 0) {
      setStatus(`已上传 ${done} 个文件`, 'ok');
      await reload(true);
    } else {
      setStatus('没有文件被上传');
    }
  }

  uploadInput.addEventListener('change', () => {
    if (uploadInput.files) void uploadFiles(uploadInput.files);
    uploadInput.value = '';
  });

  /* ---- 拖拽上传 ---- */

  let dragDepth = 0;
  listPane.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    element.classList.add('is-drop');
  });
  listPane.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  listPane.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) element.classList.remove('is-drop');
  });
  listPane.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    element.classList.remove('is-drop');
    if (event.dataTransfer?.files) void uploadFiles(event.dataTransfer.files);
  });

  void bootstrap();

  return {
    element,
    dispose: () => {
      closed = true;
      dirty = false;
      if (statusTimer) window.clearTimeout(statusTimer);
    },
  };
}
