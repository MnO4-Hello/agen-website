/**
 * 管理后台的「内容」视图：帖子列表 + 编辑器 + 分类 + 回复。
 *
 * 契约只有两个属性（见 `views/view.ts`）：`element` 与 `dispose`。三个子面板
 * （分类 / 回复）是独立文件，这个文件只负责「谁在什么时候出现」。
 *
 * 沿用 `views/works.ts` 的五条纪律：
 *   1. `snapshot = JSON.stringify(draft)` 做脏检测，不为每个字段写一个 dirty 标记；
 *   2. `busy` 锁挡住连点（发布/隐藏/删除都是幂等但会重复落盘的操作）；
 *   3. 状态提示是**视图自带的一行**（`role="status"`），成功 4 秒淡出、错误常驻，
 *      项目里没有 toast，也不该为此引入；
 *   4. 破坏性操作一律 `window.confirm`，文案写清后果；
 *   5. `dispose()` 里 `closed = true` + 清定时器，且每个 `await` 之后都要判 `closed`。
 *
 * ⚠️ 全文件零 `innerHTML`：帖子正文来自站长、回复来自游客，任何一处拼字符串都是注入面。
 */

import type { AdminPost, AdminPostInput, AdminPostStatus, BlogMeta } from '../api';
import { isOwner } from '../role';
import { button, el, formatDateTime, icon } from '../ui';
import { renderMarkdown } from '../../shared/markdown';
import type { AdminView } from './view';
import { createCategoryPanel } from './post-categories';
import { createReplyPanel } from './post-replies';
import { livePostsSource, type PostsSource } from './post-source';

type Mode = 'list' | 'edit' | 'categories' | 'replies';

interface Draft {
  id: string | null;
  slug: string;
  title: string;
  markdown: string;
  /** 封面地址（`/api/blog/media/…`）；空串 = 没有封面。 */
  coverImage: string;
  categoryId: string;
  /** 逗号分隔的原始输入，保存时才拆成数组——中途拆开会把「技术, 」这种半截输入吃掉。 */
  tagsText: string;
  status: AdminPostStatus;
  locked: boolean;
  authorName: string;
}

const MAX_TAGS = 5;
const PREVIEW_DEBOUNCE_MS = 250;

function splitTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of text.split(/[,，]/)) {
    const tag = piece.trim().replace(/^#/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

const snapshot = (draft: Draft): string => JSON.stringify(draft);

function draftFrom(post: AdminPost): Draft {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    markdown: post.markdown,
    // 老接口 / 旧缓存可能没有这个键，兜一下免得 `<img src>` 变成字符串 "undefined"。
    coverImage: post.coverImage ?? '',
    categoryId: post.categoryId,
    tagsText: post.tags.join(', '),
    status: post.status,
    locked: post.locked,
    authorName: post.author.nickname,
  };
}

export function createPostsView(source: PostsSource = livePostsSource): AdminView {
  let closed = false;
  let busy = false;
  let statusTimer = 0;
  let previewTimer = 0;
  let searchTimer = 0;

  let meta: BlogMeta | null = null;
  let posts: AdminPost[] = [];
  let mode: Mode = 'list';
  let draft: Draft | null = null;
  let savedSnapshot = '';
  /** 当前挂着的子面板（分类 / 回复）的清理函数，换视图时一起收掉。 */
  let panelDispose: (() => void) | null = null;

  const filter = { q: '', status: '', cat: '' };

  /* 外壳 ---------------------------------------------------------------- */
  const root = el('div', { className: 'bps' });

  const top = el('header', { className: 'bps__top' });
  const topText = el('div', { className: 'bps__top-text' });
  const countLine = el('p', { className: 'bps__count', text: '正在读取…' });
  topText.append(el('h2', { className: 'bps__title', text: '帖子' }), countLine);

  const topOps = el('div', { className: 'bps__top-ops' });
  const newButton = button({
    className: 'admin-btn admin-btn--primary',
    text: '写帖子',
    icon: 'plus',
    onClick: () => openNew(),
  });
  const categoriesButton = button({
    className: 'admin-btn',
    text: '分类',
    onClick: () => openCategories(),
  });
  const refreshButton = button({
    className: 'admin-iconbtn',
    title: '刷新',
    onClick: () => void reload(true),
  });
  refreshButton.append(icon('refresh', 16));
  topOps.append(newButton, categoriesButton, refreshButton);
  top.append(topText, topOps);

  /*
   * 管理员看到的是「审核视图」：不能写、不能改、不能删，也不能动分类。
   *
   * 后端还有一层（`admin/guard.ts` 的 `OWNER_ONLY`），这里只是别让人点进一个
   * 只会 403 的按钮。留一句说明，比默默少几个按钮更清楚发生了什么。
   */
  if (!isOwner()) {
    newButton.hidden = true;
    categoriesButton.hidden = true;
    countLine.after(
      el('p', {
        className: 'bps__readonly',
        text: '你是管理员：可以下架帖子、隐藏回复，但内容只由站长发布。',
      }),
    );
  }

  const status = el('p', { className: 'bps__status' });
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const filterBar = el('div', { className: 'bps__filters' });
  const searchInput = el('input', {
    className: 'admin-input admin-input--search',
    attrs: { type: 'search', placeholder: '搜索标题、正文或标签…', 'aria-label': '搜索帖子' },
  });
  const statusSelect = el('select', { className: 'admin-select', attrs: { 'aria-label': '按状态筛选' } });
  for (const [value, label] of [
    ['', '全部状态'],
    ['published', '已发布'],
    ['draft', '草稿'],
  ] as const) {
    const option = el('option', { text: label });
    option.value = value;
    statusSelect.append(option);
  }
  const categorySelect = el('select', {
    className: 'admin-select',
    attrs: { 'aria-label': '按分类筛选' },
  });
  filterBar.append(searchInput, statusSelect, categorySelect);

  const body = el('div', { className: 'bps__body' });
  root.append(top, status, filterBar, body);

  /* 状态行 -------------------------------------------------------------- */

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', tone === 'error');
    status.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
        status.hidden = true;
      }, 4000);
    }
  }

  /* 列表 ---------------------------------------------------------------- */

  async function reload(silent = false): Promise<void> {
    if (!silent) setStatus('正在读取帖子…');
    const result = await source.list({ q: filter.q, status: filter.status, cat: filter.cat });
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    posts = result.data.posts;
    renderList();
    if (!silent) setStatus('');
  }

  function rowOf(post: AdminPost): HTMLElement {
    const row = el('div', { className: `bps__row${post.status === 'draft' ? ' is-draft' : ''}` });

    const main = el('div', { className: 'bps__row-main' });

    const head = el('div', { className: 'bps__row-head' });
    const publish = button({
      className: `admin-pill bps__publish${post.status === 'published' ? ' is-on' : ''}`,
      text: post.status === 'published' ? '已发布' : '草稿',
      title: post.status === 'published' ? '点击下架（前台立刻看不到）' : '点击发布',
      onClick: () => void togglePublish(post),
    });
    head.append(publish);

    const title = el('button', {
      className: 'bps__row-title',
      text: post.title,
      attrs: { type: 'button', title: '编辑这篇帖子' },
    });
    title.addEventListener('click', () => void openEdit(post.id));
    head.append(title);

    if (post.locked) head.append(el('span', { className: 'admin-pill', text: '回复已关闭' }));
    main.append(head);

    const metaLine = el('div', { className: 'bps__row-meta' });
    const categoryName =
      meta?.categories.find((category) => category.id === post.categoryId)?.name ?? '未分类';
    metaLine.append(el('span', { className: 'bps__tag is-cat', text: categoryName }));
    for (const tag of post.tags) {
      metaLine.append(el('span', { className: 'bps__tag', text: `#${tag}` }));
    }
    metaLine.append(
      el('span', { className: 'bps__time', text: formatDateTime(Date.parse(post.updatedAt)) }),
    );
    main.append(metaLine);

    const stats = el('div', { className: 'bps__row-stats' });
    stats.append(
      el('span', { text: `${post.replyCount} 回复` }),
      el('span', { className: 'bps__sep', text: '·' }),
      el('span', { text: `赞 ${post.up} / 踩 ${post.down}` }),
    );

    const ops = el('div', { className: 'bps__row-ops' });
    const edit = button({
      className: 'admin-iconbtn',
      title: '编辑',
      icon: 'pencil',
      onClick: () => void openEdit(post.id),
    });
    const replies = button({
      className: 'admin-btn',
      text: '回复',
      title: '管理这篇帖子的回复',
      onClick: () => openReplies(post),
    });
    const remove = button({
      className: 'admin-iconbtn admin-iconbtn--danger',
      title: '删除',
      icon: 'trash',
      onClick: () => void removePost(post),
    });
    ops.append(edit, replies, remove);

    // 编辑与删除属于内容生产（只有站长能做）；「回复」是审核，管理员保留。
    if (!isOwner()) {
      edit.hidden = true;
      remove.hidden = true;
    }

    row.append(main, stats, ops);
    return row;
  }

  function renderList(): void {
    mode = 'list';
    filterBar.hidden = false;
    /*
     * 回到列表时必须**重新按身份**决定这两个按钮的可见性。
     * 原来这里无条件 `hidden = false`，会把我上面那句「管理员藏起来」的初始化盖掉
     * （列表是每次切回来都重画的，所以看起来像是初始化没生效）。
     */
    newButton.hidden = !isOwner();
    categoriesButton.hidden = !isOwner();

    const published = posts.filter((post) => post.status === 'published').length;
    countLine.textContent =
      posts.length === 0
        ? '还没有帖子'
        : `共 ${posts.length} 篇 · 已发布 ${published} 篇 · 草稿 ${posts.length - published} 篇`;

    if (posts.length === 0) {
      const empty = el('div', { className: 'bps__empty' });
      empty.append(
        el('p', { text: filter.q || filter.status || filter.cat ? '这个筛选下没有帖子。' : '还没有帖子，点右上角「写帖子」开始。' }),
      );
      body.replaceChildren(empty);
      return;
    }

    body.replaceChildren(el('div', { className: 'bps__list' }, posts.map(rowOf)));
  }

  async function togglePublish(post: AdminPost): Promise<void> {
    if (busy) return;
    busy = true;
    const next: AdminPostStatus = post.status === 'published' ? 'draft' : 'published';
    const result = await source.setStatus(post.id, next);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    setStatus(next === 'published' ? '已发布，前台刷新即可看到。' : '已下架，前台不再显示。', 'ok');
    await reload(true);
  }

  async function removePost(post: AdminPost): Promise<void> {
    if (busy) return;
    const ok = window.confirm(
      `删除《${post.title}》？\n\n它下面的 ${post.replyCount} 条回复会一起删掉，不能撤销。`,
    );
    if (!ok) return;
    busy = true;
    const result = await source.remove(post.id);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    setStatus(`删掉了，连带 ${result.data.removedReplies} 条回复。`, 'ok');
    await reload(true);
  }

  /* 编辑器 -------------------------------------------------------------- */

  function openNew(): void {
    if (busy) return;
    const fallbackCategory = meta?.categories[0]?.id ?? '';
    draft = {
      id: null,
      slug: '',
      title: '',
      markdown: '',
      coverImage: '',
      categoryId: fallbackCategory,
      tagsText: '',
      status: 'draft',
      locked: false,
      authorName: meta?.author.nickname ?? '站长',
    };
    savedSnapshot = '';
    renderEditor();
  }

  async function openEdit(id: string): Promise<void> {
    if (busy) return;
    if (!canLeaveEditor()) return;
    busy = true;
    setStatus('正在读取…');
    const result = await source.get(id);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    draft = draftFrom(result.data.post);
    savedSnapshot = snapshot(draft);
    setStatus('');
    renderEditor();
  }

  function canLeaveEditor(): boolean {
    if (mode !== 'edit' || !draft) return true;
    if (snapshot(draft) === savedSnapshot) return true;
    return window.confirm('当前编辑还没保存，确定要放弃吗？');
  }

  function updateSaveButton(saveButton: HTMLButtonElement): void {
    if (!draft) return;
    const dirty = snapshot(draft) !== savedSnapshot;
    saveButton.classList.toggle('is-dirty', dirty);
    saveButton.disabled = busy || !dirty;
  }

  function renderEditor(): void {
    if (!draft) return;
    mode = 'edit';
    filterBar.hidden = true;
    newButton.hidden = true;
    categoriesButton.hidden = false;

    const editing = draft;
    const wrap = el('div', { className: 'bpe' });

    const head = el('div', { className: 'bpe__head' });
    const back = button({
      className: 'admin-btn admin-btn--ghost',
      text: '返回列表',
      onClick: () => {
        if (!canLeaveEditor()) return;
        draft = null;
        void reload(true);
      },
    });
    const saveButton = button({
      className: 'admin-btn admin-btn--primary bpe__save',
      text: '保存',
      icon: 'save',
      disabled: true,
      onClick: () => void save(saveButton),
    });
    head.append(
      back,
      el('span', {
        className: 'bpe__heading',
        text: editing.id ? '编辑帖子' : '新帖子',
      }),
      saveButton,
    );

    const grid = el('div', { className: 'bpe__grid' });
    const form = el('div', { className: 'bpe__form' });

    const field = (label: string, control: HTMLElement, hint?: string): HTMLElement => {
      const box = el('label', { className: 'bpe__field' });
      box.append(el('span', { className: 'bpe__label', text: label }), control);
      if (hint) box.append(el('span', { className: 'bpe__hint', text: hint }));
      return box;
    };

    const markDirty = (): void => updateSaveButton(saveButton);

    /* 标题 */
    const titleInput = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', placeholder: '一句话说清这篇讲什么', maxlength: 80 },
    });
    titleInput.value = editing.title;
    titleInput.addEventListener('input', () => {
      editing.title = titleInput.value;
      markDirty();
    });

    /* slug */
    const slugRow = el('div', { className: 'bpe__inline' });
    const slugInput = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', placeholder: '留空则按标题自动生成', maxlength: 64 },
    });
    slugInput.value = editing.slug;
    slugInput.addEventListener('input', () => {
      editing.slug = slugInput.value;
      markDirty();
    });
    const regenerate = button({
      className: 'admin-btn',
      text: '按标题生成',
      onClick: () => {
        editing.slug = '';
        slugInput.value = '';
        markDirty();
      },
    });
    slugRow.append(slugInput, regenerate);

    /* 分类 */
    const categoryField = el('select', { className: 'admin-select' });
    const fillCategories = (): void => {
      const options = (meta?.categories ?? []).map((category) => {
        const option = el('option', { text: `${category.name}（${category.count}）` });
        option.value = category.id;
        return option;
      });
      categoryField.replaceChildren(...options);
      if (!editing.categoryId && meta?.categories[0]) editing.categoryId = meta.categories[0].id;
      categoryField.value = editing.categoryId;
    };
    fillCategories();
    categoryField.addEventListener('change', () => {
      editing.categoryId = categoryField.value;
      markDirty();
    });

    /* 标签 */
    const tagsInput = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', placeholder: '用逗号分隔，最多 5 个' },
    });
    tagsInput.value = editing.tagsText;
    tagsInput.addEventListener('input', () => {
      editing.tagsText = tagsInput.value;
      markDirty();
    });

    /* 作者署名 */
    const authorInput = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', placeholder: '显示在帖子头部', maxlength: 24 },
    });
    authorInput.value = editing.authorName;
    authorInput.addEventListener('input', () => {
      editing.authorName = authorInput.value;
      markDirty();
    });

    /* 正文 */
    const markdownInput = el('textarea', {
      className: 'admin-input bpe__markdown',
      attrs: { rows: 20, placeholder: '# 标题\n\n正文支持 Markdown：标题、列表、引用、代码块、链接、图片。' },
    });
    markdownInput.value = editing.markdown;
    markdownInput.addEventListener('input', () => {
      editing.markdown = markdownInput.value;
      markDirty();
      schedulePreview();
    });

    /* 图片：上传 / 拖拽 / 粘贴，一律插到光标处 ------------------------------ */

    let uploading = false;
    const mediaStatus = el('span', { className: 'bpe__media-status' });
    const setMediaStatus = (text: string, tone: 'info' | 'ok' | 'error' = 'info'): void => {
      mediaStatus.textContent = text;
      mediaStatus.classList.toggle('is-error', tone === 'error');
      mediaStatus.classList.toggle('is-ok', tone === 'ok');
      if (tone === 'ok') {
        window.setTimeout(() => {
          if (!closed) mediaStatus.textContent = '';
        }, 4000);
      }
    };

    const thumbs = el('div', { className: 'bpe__thumbs' });
    thumbs.hidden = true;

    /** 把一段 Markdown 插到光标处（选中的内容会被替换）。 */
    const insertAtCursor = (text: string): void => {
      const start = markdownInput.selectionStart ?? markdownInput.value.length;
      const end = markdownInput.selectionEnd ?? start;
      const before = markdownInput.value.slice(0, start);
      // 前后补换行：Markdown 里图片要独占一段，否则会和上一句话挤成同一段。
      const block = `${before && !before.endsWith('\n') ? '\n' : ''}${text}\n`;
      markdownInput.setRangeText(block, start, end, 'end');
      // 触发 input 事件，让「脏检测 + 实时预览」走同一条路，而不是在这里各写一遍。
      markdownInput.dispatchEvent(new Event('input', { bubbles: true }));
      markdownInput.focus();
    };

    const addThumb = (url: string, alt: string): void => {
      thumbs.hidden = false;
      const thumb = el('button', {
        className: 'bpe__thumb',
        attrs: { type: 'button', title: '再插入一次' },
      });
      thumb.append(el('img', { attrs: { src: url, alt, loading: 'lazy' } }));
      thumb.addEventListener('click', () => insertAtCursor(`![${alt}](${url})`));
      thumbs.append(thumb);
    };

    const uploadAndInsert = async (file: File): Promise<void> => {
      if (uploading) return;
      if (!file.type.startsWith('image/')) {
        setMediaStatus('只能传图片。', 'error');
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setMediaStatus('图片太大了（上限 8 MB）。', 'error');
        return;
      }

      uploading = true;
      uploadButton.disabled = true;
      setMediaStatus('正在上传…');
      const result = await source.uploadMedia(file);
      uploading = false;
      if (closed) return;
      uploadButton.disabled = false;

      if (!result.ok) {
        setMediaStatus(result.message, 'error');
        return;
      }
      const alt = file.name.replace(/\.[^.]+$/, '') || '插图';
      insertAtCursor(`![${alt}](${result.data.url})`);
      addThumb(result.data.url, alt);
      setMediaStatus('已插入到光标处。', 'ok');
    };

    const imageOf = (data: DataTransfer | null): File | null => {
      if (!data) return null;
      for (const file of Array.from(data.files)) {
        if (file.type.startsWith('image/')) return file;
      }
      return null;
    };

    markdownInput.addEventListener('dragover', (event) => {
      const items = Array.from(event.dataTransfer?.items ?? []);
      if (items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) {
        event.preventDefault();
      }
    });

    markdownInput.addEventListener('drop', (event) => {
      const file = imageOf(event.dataTransfer);
      if (!file) return;
      event.preventDefault();
      void uploadAndInsert(file);
    });

    // 截图工具复制出来的是剪贴板里的图片文件，不是文本——直接粘就能传。
    markdownInput.addEventListener('paste', (event) => {
      const file = imageOf(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      void uploadAndInsert(file);
    });

    const fileInput = el('input', {
      className: 'bpe__file',
      attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif' },
    });
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void uploadAndInsert(file);
    });

    const uploadButton = button({
      className: 'admin-btn',
      text: '上传图片',
      icon: 'image',
      onClick: () => fileInput.click(),
    });

    const mediaHead = el('div', { className: 'bpe__media-head' }, [
      uploadButton,
      fileInput,
      el('span', {
        className: 'bpe__hint',
        text: '也可以把图片拖进正文，或直接 Ctrl+V 粘贴。',
      }),
      mediaStatus,
    ]);

    const mediaPanel = el('div', { className: 'bpe__media' }, [mediaHead, thumbs]);

    /* 封面：显式上传 --------------------------------------------------------
       只认这里传的图，**不从正文首图派生**：正文里的图是排版用的，一张装饰图
       被当成封面会让人莫名其妙。 */
    let coverUploading = false;
    const coverStatus = el('span', { className: 'bpe__media-status' });
    const setCoverStatus = (text: string, tone: 'info' | 'ok' | 'error' = 'info'): void => {
      coverStatus.textContent = text;
      coverStatus.classList.toggle('is-error', tone === 'error');
      coverStatus.classList.toggle('is-ok', tone === 'ok');
      if (tone === 'ok') {
        window.setTimeout(() => {
          if (!closed) coverStatus.textContent = '';
        }, 4000);
      }
    };

    const coverPreview = el('div', { className: 'bpe__cover' });
    const renderCover = (): void => {
      coverPreview.replaceChildren();
      if (editing.coverImage) {
        coverPreview.append(
          el('img', { attrs: { src: editing.coverImage, alt: '封面预览', loading: 'lazy' } }),
        );
        return;
      }
      coverPreview.append(el('span', { className: 'bpe__hint', text: '还没有封面' }));
    };
    renderCover();

    const coverInput = el('input', {
      className: 'bpe__file',
      attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif' },
    });
    coverInput.hidden = true;

    const coverButton = button({
      className: 'admin-btn',
      text: '上传封面',
      icon: 'image',
      onClick: () => coverInput.click(),
    });

    const uploadCover = async (file: File): Promise<void> => {
      if (coverUploading) return;
      if (!file.type.startsWith('image/')) {
        setCoverStatus('只能传图片。', 'error');
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setCoverStatus('图片太大了（上限 8 MB）。', 'error');
        return;
      }

      coverUploading = true;
      coverButton.disabled = true;
      setCoverStatus('正在上传…');
      const result = await source.uploadMedia(file);
      coverUploading = false;
      if (closed) return;
      coverButton.disabled = false;

      if (!result.ok) {
        setCoverStatus(result.message, 'error');
        return;
      }
      editing.coverImage = result.data.url;
      renderCover();
      markDirty();
      setCoverStatus('封面已更新，保存后生效。', 'ok');
    };

    coverInput.addEventListener('change', () => {
      const file = coverInput.files?.[0];
      coverInput.value = '';
      if (file) void uploadCover(file);
    });

    const clearCoverButton = button({
      className: 'admin-btn',
      text: '清除',
      onClick: () => {
        editing.coverImage = '';
        renderCover();
        markDirty();
        setCoverStatus('保存后清除封面。', 'ok');
      },
    });

    const coverPanel = el('div', { className: 'bpe__cover-panel' }, [
      coverPreview,
      el('div', { className: 'bpe__cover-side' }, [
        el('div', { className: 'bpe__inline' }, [coverButton, coverInput, clearCoverButton]),
        coverStatus,
      ]),
    ]);

    /* 开关 */
    const publishToggle = el('input', { attrs: { type: 'checkbox' } });
    publishToggle.checked = editing.status === 'published';
    publishToggle.addEventListener('change', () => {
      editing.status = publishToggle.checked ? 'published' : 'draft';
      markDirty();
    });
    const lockedToggle = el('input', { attrs: { type: 'checkbox' } });
    lockedToggle.checked = editing.locked;
    lockedToggle.addEventListener('change', () => {
      editing.locked = lockedToggle.checked;
      markDirty();
    });

    const switches = el('div', { className: 'bpe__switches' });
    const switchRow = (input: HTMLInputElement, label: string, hint: string): HTMLElement => {
      const line = el('label', { className: 'admin-check-label' });
      line.append(input, el('span', { text: label }), el('span', { className: 'bpe__hint', text: hint }));
      return line;
    };
    switches.append(
      switchRow(publishToggle, '发布到前台', '关掉就是草稿，只有后台看得到'),
      switchRow(lockedToggle, '关闭回复', '已有回复保留，只是不能再发新的'),
    );

    form.append(
      field('标题', titleInput),
      field('slug', slugRow, '链接是 #blog/<slug>，改过之后旧链接会失效。'),
      field('分类', categoryField, (meta?.categories.length ?? 0) === 0 ? '还没有分类，先去「分类」建一个。' : ''),
      field('标签', tagsInput, '会显示在卡片与详情页的头部。'),
      field('作者署名', authorInput),
      field('封面图', coverPanel, '只有这里上传的图才会出现在博客列表卡片最左侧；不填就是纯文字卡片。'),
      field('正文（Markdown）', markdownInput, '支持标题、列表、引用、代码块、链接与图片；右边是实时预览。'),
      mediaPanel,
      switches,
    );

    /* 预览 */
    const aside = el('aside', { className: 'bpe__aside' });
    const previewTitle = el('p', { className: 'bpe__aside-title', text: '预览' });
    const previewBody = el('div', { className: 'md-body bpe__preview' });
    previewBody.append(renderMarkdown(editing.markdown || '（正文还空着）'));
    aside.append(previewTitle, previewBody);

    function schedulePreview(): void {
      if (previewTimer) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        previewTimer = 0;
        if (closed || !draft) return;
        previewBody.replaceChildren(renderMarkdown(draft.markdown || '（正文还空着）'));
      }, PREVIEW_DEBOUNCE_MS);
    }

    grid.append(form, aside);
    wrap.append(head, grid);
    body.replaceChildren(wrap);
    updateSaveButton(saveButton);

    async function save(button: HTMLButtonElement): Promise<void> {
      if (!draft || busy) return;
      const input: AdminPostInput = {
        title: draft.title.trim(),
        markdown: draft.markdown,
        coverImage: draft.coverImage,
        categoryId: draft.categoryId,
        tags: splitTags(draft.tagsText),
        status: draft.status,
        locked: draft.locked,
        authorName: draft.authorName.trim(),
        slug: draft.slug.trim(),
      };
      if (!input.title) {
        setStatus('标题不能为空。', 'error');
        titleInput.focus();
        return;
      }
      if (!input.categoryId) {
        setStatus('先选一个分类：发帖时必须归类。', 'error');
        return;
      }

      busy = true;
      button.disabled = true;
      setStatus('正在保存…');
      const result = draft.id ? await source.update(draft.id, input) : await source.create(input);
      busy = false;
      if (closed) return;

      if (!result.ok) {
        setStatus(result.message, 'error');
        updateSaveButton(button);
        return;
      }

      const saved = result.data.post;
      draft = draftFrom(saved);
      savedSnapshot = snapshot(draft);
      setStatus(`已保存 · ${formatDateTime(Date.parse(saved.updatedAt))}。前台刷新即可看到。`, 'ok');
      // 重画一次：slug 可能被服务端补上了，输入框要跟着显示出来。
      renderEditor();
      await reload(true);
    }
  }

  /* 分类 / 回复 --------------------------------------------------------- */

  function openCategories(): void {
    if (mode === 'categories') return;
    if (!canLeaveEditor()) return;
    mode = 'categories';
    filterBar.hidden = true;
    newButton.hidden = true;
    categoriesButton.hidden = true;

    const panel = createCategoryPanel({
      source,
      setStatus,
      onChanged: () => void loadMeta(),
    });
    panelDispose = () => panel.dispose();
    const head = el('div', { className: 'bps__subhead' });
    head.append(
      button({
        className: 'admin-btn admin-btn--ghost',
        text: '返回列表',
        onClick: () => {
          panel.dispose();
          panelDispose = null;
          draft = null;
          void reload(true);
        },
      }),
      el('span', { className: 'bpe__heading', text: '分类' }),
    );
    body.replaceChildren(head, panel.element);
  }

  function openReplies(post: AdminPost): void {
    if (!canLeaveEditor()) return;
    mode = 'replies';
    filterBar.hidden = true;
    newButton.hidden = true;
    categoriesButton.hidden = false;

    const panel = createReplyPanel({
      source,
      post,
      setStatus,
      onBack: () => {
        panel.dispose();
        panelDispose = null;
        void reload(true);
      },
    });
    panelDispose = () => panel.dispose();
    body.replaceChildren(panel.element);
  }

  /* 初始化 -------------------------------------------------------------- */

  function syncCategoryOptions(): void {
    const categories = meta?.categories ?? [];
    const previous = filter.cat;
    const all = el('option', { text: '全部分类' });
    all.value = '';
    const options = categories.map((category) => {
      const option = el('option', { text: category.name });
      option.value = category.id;
      return option;
    });
    categorySelect.replaceChildren(all, ...options);
    // 分类被删掉之后，原来选中的 id 已经不存在 → 静默回到「全部」。
    filter.cat = categories.some((category) => category.id === previous) ? previous : '';
    categorySelect.value = filter.cat;
  }

  async function loadMeta(): Promise<void> {
    const result = await source.meta();
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    meta = result.data;
    syncCategoryOptions();
    if (mode === 'list') renderList();
  }

  searchInput.addEventListener('input', () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = 0;
      filter.q = searchInput.value.trim();
      void reload(true);
    }, 250);
  });

  statusSelect.addEventListener('change', () => {
    filter.status = statusSelect.value;
    void reload(true);
  });

  categorySelect.addEventListener('change', () => {
    filter.cat = categorySelect.value;
    void reload(true);
  });

  void loadMeta();
  void reload();

  return {
    element: root,
    dispose: () => {
      closed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      if (previewTimer) window.clearTimeout(previewTimer);
      if (searchTimer) window.clearTimeout(searchTimer);
      panelDispose?.();
      panelDispose = null;
      draft = null;
      posts = [];
    },
  };
}
