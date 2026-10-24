/**
 * 管理后台「作品」视图。
 *
 * 两个状态：**列表**（看全部作品、调顺序、发布 / 下线、删）与**编辑**（新建或改一条）。
 * 编辑器里有一个模式开关：
 *
 *   · **模板模式**：填标题、简介、标签、链接、封面、图集、README(Markdown)，站点用统一版式渲染；
 *   · **开发者模式**：直接写整页 HTML（可内嵌 `<style>` / `<script>`），右侧沙箱 iframe 实时预览。
 *
 * 三条纪律：
 *   1. **全项目禁止 `innerHTML`**：所有节点都走 `el()` / `textContent`。作品正文是作者
 *      自己写的，但「自己写的」不等于「一定安全」——粘贴一段带脚本的 HTML 是很容易的事。
 *   2. **预览用沙箱 iframe**，`sandbox` 不带 `allow-same-origin`：预览里跑的代码不该
 *      摸得到后台的 cookie（那可是管理员会话）。
 *   3. **`dispose()` 清定时器**：预览防抖与状态行各有一个 timer，切视图前必须收掉。
 *
 * 数据源通过 `WorksSource` 注入：生产用 `./api` 里的真实实现，`?preview=works`
 * 用 `preview.ts` 里的假数据（截图改样式时不用登录）。
 */

import {
  createWork,
  deleteWork,
  fetchAdminWorks,
  reorderWorks,
  setWorkPublished,
  updateWork,
  uploadWorkMedia,
  type AdminWork,
  type ApiResult,
  type SavedMedia,
  type WorkInput,
  type WorkMode,
} from '../api';
import { button, el, formatDateTime, icon } from '../ui';
import type { AdminView } from './view';

/**
 * 视图依赖的数据源。
 *
 * 抽出来只为 `?preview=works` 能塞假数据（见 `preview.ts`）——改样式时不用登录、
 * 也不用担心把真实作品改坏。生产路径就是下面那份 `liveSource`。
 */
export interface WorksSource {
  list: () => Promise<ApiResult<{ works: AdminWork[] }>>;
  create: (input: WorkInput) => Promise<ApiResult<{ work: AdminWork }>>;
  update: (id: string, input: WorkInput) => Promise<ApiResult<{ work: AdminWork }>>;
  remove: (id: string) => Promise<ApiResult<{ ok: boolean; trashedTo: string | null }>>;
  publish: (id: string, published: boolean) => Promise<ApiResult<{ work: AdminWork }>>;
  reorder: (ids: string[]) => Promise<ApiResult<{ works: AdminWork[] }>>;
  upload: (file: File) => Promise<ApiResult<SavedMedia>>;
}

const liveSource: WorksSource = {
  list: fetchAdminWorks,
  create: createWork,
  update: updateWork,
  remove: deleteWork,
  publish: setWorkPublished,
  reorder: reorderWorks,
  upload: uploadWorkMedia,
};

/** 编辑器里的草稿。字段基本与 `AdminWork` 对齐，差异有两处，都是为了输入框好用。 */
interface Draft {
  id: string | null;
  mode: WorkMode;
  title: string;
  slug: string;
  summary: string;
  /** 输入框里是「逗号分隔的一行」，保存时才拆成数组。 */
  tags: string;
  year: string;
  category: string;
  repoUrl: string;
  demoUrl: string;
  thumbnail: string;
  gallery: string[];
  readme: string;
  html: string;
  published: boolean;
  order: number;
}

function emptyDraft(): Draft {
  return {
    id: null,
    mode: 'template',
    title: '',
    slug: '',
    summary: '',
    tags: '',
    year: String(new Date().getFullYear()),
    category: '',
    repoUrl: '',
    demoUrl: '',
    thumbnail: '',
    gallery: [],
    readme: '',
    html: '',
    published: false,
    order: 0,
  };
}

function draftFrom(work: AdminWork): Draft {
  return {
    id: work.id,
    mode: work.mode,
    title: work.title,
    slug: work.slug,
    summary: work.summary,
    tags: work.tags.join(', '),
    year: work.year,
    category: work.category,
    repoUrl: work.repoUrl,
    demoUrl: work.demoUrl,
    thumbnail: work.thumbnail,
    gallery: [...work.gallery],
    readme: work.readme,
    html: work.html,
    published: work.published,
    order: work.order,
  };
}

/** 草稿 → 提交体。`slug` 传空串表示「让后端按标题重新生成」。 */
function inputFrom(draft: Draft): WorkInput {
  return {
    mode: draft.mode,
    title: draft.title,
    slug: draft.slug.trim(),
    summary: draft.summary,
    tags: draft.tags
      .split(/[,，、\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    year: draft.year,
    category: draft.category,
    repoUrl: draft.repoUrl,
    demoUrl: draft.demoUrl,
    thumbnail: draft.thumbnail,
    gallery: [...draft.gallery],
    readme: draft.readme,
    html: draft.html,
    published: draft.published,
    order: draft.order,
  };
}

const snapshot = (draft: Draft): string => JSON.stringify(draft);

/** 预览 iframe 的初始内容：作者还没写东西时给一段提示，而不是空白页。 */
const EMPTY_HTML =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;' +
  'font:14px/1.8 system-ui,sans-serif;color:#55705f;background:#f7faf5}</style>' +
  '<p>这里是你的页面。写点 HTML，右边会实时更新。</p></html>';

export function createWorksView(source: WorksSource = liveSource): AdminView {
  let closed = false;
  let works: AdminWork[] = [];
  let draft: Draft | null = null;
  let savedSnapshot = '';
  let isNew = false;
  let busy = false;

  let statusTimer = 0;
  let previewTimer = 0;

  /* —— 外壳 —— */
  const heading = el('h2', { className: 'wks__heading', text: '作品' });
  const count = el('span', { className: 'wks__count', text: '' });

  const createButton = button({
    className: 'admin-btn admin-btn--primary',
    icon: 'plus',
    text: '新建作品',
    onClick: () => openEditor(null),
  });

  const refreshButton = button({
    className: 'admin-btn',
    icon: 'refresh',
    text: '刷新',
    onClick: () => void reload(),
  });

  const bar = el('div', { className: 'wks__bar' }, [
    el('div', { className: 'wks__bar-lead' }, [heading, count]),
    el('div', { className: 'wks__bar-actions' }, [refreshButton, createButton]),
  ]);

  const status = el('p', { className: 'wks__status', attrs: { role: 'status', 'aria-live': 'polite' } });

  const list = el('div', { className: 'wks__list' });
  const editorHost = el('div', { className: 'wks__editor', attrs: { hidden: true } });

  const element = el('section', { className: 'wks' }, [bar, status, list, editorHost]);

  /* —— 状态行 —— */
  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', tone === 'error');
    status.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    // 成功提示自动淡出；错误留着，等下一次操作覆盖——它通常需要人看见。
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
        status.hidden = true;
      }, 4000);
    }
  }

  /* —— 列表 —— */
  function thumbNode(work: AdminWork): HTMLElement {
    const box = el('div', { className: 'wks__thumb' });
    if (work.thumbnail) {
      const img = el('img', { attrs: { src: work.thumbnail, alt: '', loading: 'lazy' } });
      box.append(img);
    } else {
      box.append(el('span', { className: 'wks__thumb-glyph', text: work.title.slice(0, 1) || '作' }));
    }
    return box;
  }

  function rowFor(work: AdminWork, index: number): HTMLElement {
    const modeBadge = el('span', {
      className: `wks__badge${work.mode === 'developer' ? ' is-dev' : ''}`,
      text: work.mode === 'developer' ? '自定义' : '模板',
    });

    const publishButton = el('button', {
      className: `wks__publish${work.published ? ' is-on' : ''}`,
      text: work.published ? '已发布' : '草稿',
      attrs: {
        type: 'button',
        title: work.published ? '点击下线（前台立刻看不到）' : '点击发布',
      },
    });
    publishButton.addEventListener('click', () => void togglePublish(work));

    const meta = el('div', { className: 'wks__rowmeta' }, [
      modeBadge,
      el('code', { className: 'wks__slug', text: `#works/${work.slug}` }),
      el('span', { className: 'wks__time', text: formatDateTime(new Date(work.updatedAt).getTime()) }),
    ]);

    const main = el('div', { className: 'wks__rowmain' }, [
      el('div', { className: 'wks__rowhead' }, [
        el('span', { className: 'wks__title', text: work.title }),
        el('span', { className: 'wks__order', text: `#${index + 1}` }),
      ]),
      meta,
      el('p', { className: 'wks__summary', text: work.summary || '（还没有简介）' }),
    ]);

    const up = button({
      className: 'admin-iconbtn',
      title: '上移',
      disabled: index === 0 || busy,
      onClick: () => void move(index, -1),
    });
    up.append(icon('chevron', 16));

    const down = button({
      className: 'admin-iconbtn',
      title: '下移',
      disabled: index === works.length - 1 || busy,
      onClick: () => void move(index, 1),
    });
    down.append(icon('chevron', 16));

    const edit = button({
      className: 'admin-btn',
      icon: 'pencil',
      text: '编辑',
      onClick: () => openEditor(work),
    });

    const removeButton = button({
      className: 'admin-iconbtn admin-iconbtn--danger',
      title: '删除',
      onClick: () => void remove(work),
    });
    removeButton.append(icon('trash', 16));

    const ops = el('div', { className: 'wks__ops' }, [up, down, publishButton, edit, removeButton]);

    return el('div', { className: `wks__row${work.published ? '' : ' is-draft'}` }, [
      thumbNode(work),
      main,
      ops,
    ]);
  }

  function renderList(): void {
    count.textContent = works.length === 0 ? '还没有作品' : `共 ${works.length} 条 · 已发布 ${works.filter((work) => work.published).length} 条`;

    if (works.length === 0) {
      list.replaceChildren(
        el('div', { className: 'wks__empty' }, [
          el('p', { text: '还没有作品。点右上角「新建作品」开始。' }),
          el('p', {
            className: 'wks__hint',
            text: '模板模式会用站点统一版式渲染；开发者模式则是一个完全由你写的整页 HTML。',
          }),
        ]),
      );
      return;
    }

    list.replaceChildren(...works.map((work, index) => rowFor(work, index)));
  }

  /* —— 数据加载 —— */
  async function reload(silent = false): Promise<void> {
    if (!silent) setStatus('正在读取…');
    const result = await source.list();
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    works = result.data.works;
    renderList();
    // 静默刷新（保存 / 删除之后）不能把「已保存」那句盖掉。
    if (!silent) setStatus('');
  }

  async function togglePublish(work: AdminWork): Promise<void> {
    if (busy) return;
    busy = true;
    const result = await source.publish(work.id, !work.published);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    works = works.map((item) => (item.id === result.data.work.id ? result.data.work : item));
    renderList();
    setStatus(result.data.work.published ? '已发布。' : '已下线。', 'ok');
  }

  async function move(index: number, delta: number): Promise<void> {
    const target = index + delta;
    if (busy || target < 0 || target >= works.length) return;

    const next = [...works];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    works = next;
    renderList();

    busy = true;
    const result = await source.reorder(works.map((work) => work.id));
    busy = false;
    if (closed) return;
    if (!result.ok) {
      // 排序失败就重新拉一遍：本地这份顺序已经不可信了。
      setStatus(result.message, 'error');
      await reload(true);
      return;
    }
    works = result.data.works;
    renderList();
  }

  async function remove(work: AdminWork): Promise<void> {
    if (busy) return;
    const sure = window.confirm(
      `删除「${work.title}」？\n\n记录会被移除，图片会先挪到 .admin-trash/ 回收站（不会真删）。`,
    );
    if (!sure) return;

    busy = true;
    setStatus('正在删除…');
    const result = await source.remove(work.id);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    works = works.filter((item) => item.id !== work.id);
    renderList();
    setStatus(result.data.trashedTo ? `已删除，图片在 ${result.data.trashedTo}。` : '已删除。', 'ok');
  }

  /* —— 编辑器 —— */
  function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    const wrap = el('label', { className: 'wks__field' }, [
      el('span', { className: 'wks__label', text: label }),
      control,
    ]);
    if (hint) wrap.append(el('span', { className: 'wks__hint', text: hint }));
    return wrap;
  }

  function textInput(value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
    const input = el('input', { className: 'admin-input', attrs: { type: 'text', placeholder } });
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      markDirty();
    });
    return input;
  }

  function textArea(value: string, placeholder: string, rows: number, onChange: (value: string) => void): HTMLTextAreaElement {
    const area = el('textarea', { className: 'admin-input wks__textarea', attrs: { rows, placeholder, spellcheck: 'false' } });
    area.value = value;
    area.addEventListener('input', () => {
      onChange(area.value);
      markDirty();
      schedulePreview();
    });
    return area;
  }

  /** 隐藏的文件选择器：每次点按钮时现创建，选完就丢，不用管 `value` 重置。 */
  function pickFiles(accept: string, multiple: boolean, onPicked: (files: File[]) => void): void {
    const input = el('input', { attrs: { type: 'file', accept, hidden: true } });
    if (multiple) input.multiple = true;
    const drop = (): void => input.remove();
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      drop();
      if (files.length > 0) onPicked(files);
    });
    // 取消选择不会触发 change：不补这一条，那个隐藏的 input 会一直挂在 body 上。
    input.addEventListener('cancel', drop);
    document.body.append(input);
    input.click();
  }

  async function uploadFiles(files: File[], onSaved: (media: SavedMedia) => void): Promise<void> {
    for (const file of files) {
      setStatus(`正在上传 ${file.name}…`);
      const result = await source.upload(file);
      if (closed) return;
      if (!result.ok) {
        setStatus(result.message, 'error');
        return;
      }
      onSaved(result.data);
      setStatus(`已上传 ${file.name}。`, 'ok');
    }
  }

  /** 草稿有没有改动。用来在切换 / 关闭前提醒一句，避免手滑丢掉一屏字。 */
  function markDirty(): void {
    if (!draft) return;
    const dirty = snapshot(draft) !== savedSnapshot;
    saveButton.classList.toggle('is-dirty', dirty);
    saveButton.disabled = busy || !dirty;
  }

  function schedulePreview(): void {
    if (previewTimer) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      renderPreview();
    }, 250);
  }

  /* —— 预览 —— */
  let previewFrame: HTMLIFrameElement | null = null;
  const previewBox = el('aside', { className: 'wks__preview' });

  function renderPreview(): void {
    if (!draft) return;
    previewBox.replaceChildren();
    previewFrame = null;

    const head = el('div', { className: 'wks__preview-head' }, [
      el('span', { className: 'wks__preview-title', text: draft.mode === 'developer' ? '实时预览' : '列表卡预览' }),
      el('span', { className: 'wks__preview-note', text: draft.mode === 'developer' ? '沙箱 iframe，和前台一致' : '前台列表里的样子' }),
    ]);

    if (draft.mode === 'developer') {
      const frame = document.createElement('iframe');
      frame.className = 'wks__frame';
      frame.title = '自定义页面预览';
      /*
       * 不带 `allow-same-origin`：预览里跑的是作者自己写的脚本，但它不该摸得到
       * 后台会话的 cookie。加了它等于把整个沙箱作废。
       */
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = draft.html.trim() || EMPTY_HTML;
      previewFrame = frame;
      previewBox.append(head, el('div', { className: 'wks__frame-wrap' }, [frame]));
      return;
    }

    const card = el('div', { className: 'wks__cardpreview' });
    const cover = el('div', { className: 'wks__cardcover' });
    if (draft.thumbnail) {
      cover.append(el('img', { attrs: { src: draft.thumbnail, alt: '' } }));
    } else {
      cover.append(el('span', { className: 'wks__thumb-glyph', text: draft.title.slice(0, 1) || '作' }));
    }
    card.append(
      cover,
      el('div', { className: 'wks__cardbody' }, [
        el('h4', { className: 'wks__cardtitle', text: draft.title || '作品标题' }),
        el('p', { className: 'wks__cardsummary', text: draft.summary || '一句话简介会显示在这里。' }),
        el('div', { className: 'wks__cardmeta' }, [
          ...draft.tags
            .split(/[,，、\s]+/)
            .filter(Boolean)
            .slice(0, 4)
            .map((tag) => el('span', { className: 'wks__cardtag', text: tag })),
        ]),
      ]),
    );
    previewBox.append(head, card);
  }

  /* —— 编辑器的头 / 底 —— */
  const editorTitle = el('h3', { className: 'wks__editor-title', text: '编辑作品' });
  const editorSub = el('p', { className: 'wks__editor-sub', text: '' });

  const closeButton = button({
    className: 'admin-iconbtn',
    title: '关闭',
    onClick: () => closeEditor(),
  });
  closeButton.append(icon('close', 16));

  const editorHead = el('header', { className: 'wks__editor-head' }, [
    el('div', {}, [editorTitle, editorSub]),
    closeButton,
  ]);

  const editorFootStatus = el('p', { className: 'wks__editor-status', attrs: { role: 'status' } });

  const saveButton = button({
    className: 'admin-btn admin-btn--primary',
    icon: 'save',
    text: '保存',
    onClick: () => void save(),
  });

  const editorFoot = el('footer', { className: 'wks__editor-foot' }, [editorFootStatus, saveButton]);

  /* —— 编辑器主体 —— */
  function renderEditor(): void {
    if (!draft) return;
    const current = draft;

    editorTitle.textContent = isNew ? '新建作品' : '编辑作品';
    editorSub.textContent = isNew
      ? '先选一种模式：模板模式用站点版式，开发者模式写整页 HTML。'
      : `#works/${current.slug || '（保存后生成）'}`;

    /* 模式开关 */
    const seg = el('div', { className: 'wks__seg', attrs: { role: 'group', 'aria-label': '作品模式' } });
    const modes: Array<[WorkMode, string, string]> = [
      ['template', '模板模式', '标题 / 简介 / README，站点统一版式'],
      ['developer', '开发者模式', '整页 HTML，完全自定义'],
    ];
    for (const [mode, label, note] of modes) {
      const active = current.mode === mode;
      const option = el('button', {
        className: `wks__segitem${active ? ' is-active' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(active) },
      }, [
        el('span', { className: 'wks__segitem-label', text: label }),
        el('span', { className: 'wks__segitem-note', text: note }),
      ]);
      option.addEventListener('click', () => switchMode(mode));
      seg.append(option);
    }

    /* 基本信息 */
    const titleInput = textInput(current.title, '例如：个人站点 2026', (value) => {
      current.title = value;
      // 新建时 slug 跟着标题走；作者手动改过就不再覆盖（否则改标题会把链接改掉）。
      if (isNew && !slugTouched) {
        current.slug = suggestSlug(value);
        slugInput.value = current.slug;
      }
      renderPreview();
    });

    const slugInput = textInput(current.slug, 'demo-work', (value) => {
      current.slug = value;
      slugTouched = true;
    });
    slugInput.classList.add('wks__sluginput');
    const regenerate = button({
      className: 'admin-btn wks__regen',
      text: '按标题生成',
      onClick: () => {
        current.slug = suggestSlug(current.title);
        slugInput.value = current.slug;
        slugTouched = true;
        markDirty();
      },
    });

    const summaryInput = textArea(current.summary, '一两句话说明它是什么、解决了什么问题。', 2, (value) => {
      current.summary = value;
      renderPreview();
    });

    const tagsInput = textInput(current.tags, 'TypeScript, Vite, Canvas', (value) => {
      current.tags = value;
      renderPreview();
    });

    const yearInput = textInput(current.year, '2026', (value) => {
      current.year = value;
    });
    const categoryInput = textInput(current.category, '例如：Web / 工具', (value) => {
      current.category = value;
    });

    const repoInput = textInput(current.repoUrl, 'https://github.com/…', (value) => {
      current.repoUrl = value;
    });
    const demoInput = textInput(current.demoUrl, 'https://…', (value) => {
      current.demoUrl = value;
    });

    /* 封面 */
    const coverPreview = el('div', { className: 'wks__cover' });
    const renderCover = (): void => {
      coverPreview.replaceChildren();
      if (current.thumbnail) {
        coverPreview.append(el('img', { attrs: { src: current.thumbnail, alt: '缩略图' } }));
      } else {
        coverPreview.append(el('span', { className: 'wks__hint', text: '还没有封面。建议 16:9，1280×720 左右。' }));
      }
    };
    renderCover();

    const coverActions = el('div', { className: 'wks__fieldrow' }, [
      button({
        className: 'admin-btn',
        icon: 'upload',
        text: '上传封面',
        onClick: () =>
          pickFiles('image/*', false, (files) => {
            const file = files[0];
            if (!file) return;
            void uploadFiles([file], (media) => {
              current.thumbnail = media.url;
              renderCover();
              renderPreview();
              markDirty();
            });
          }),
      }),
      button({
        className: 'admin-btn',
        text: '清除',
        onClick: () => {
          current.thumbnail = '';
          renderCover();
          renderPreview();
          markDirty();
        },
      }),
    ]);

    /* 图集 */
    const galleryList = el('div', { className: 'wks__gallery' });
    const renderGallery = (): void => {
      galleryList.replaceChildren();
      if (current.gallery.length === 0) {
        galleryList.append(el('span', { className: 'wks__hint', text: '还没有图集。' }));
        return;
      }
      current.gallery.forEach((src, index) => {
        const item = el('div', { className: 'wks__galleryitem' }, [
          el('img', { attrs: { src, alt: '' } }),
        ]);
        const drop = button({
          className: 'admin-iconbtn admin-iconbtn--danger',
          title: '移除',
          onClick: () => {
            current.gallery.splice(index, 1);
            renderGallery();
            markDirty();
          },
        });
        drop.append(icon('close', 14));
        item.append(drop);
        galleryList.append(item);
      });
    };
    renderGallery();

    const galleryActions = el('div', { className: 'wks__fieldrow' }, [
      button({
        className: 'admin-btn',
        icon: 'plus',
        text: '添加图片',
        onClick: () =>
          pickFiles('image/*', true, (files) => {
            void uploadFiles(files, (media) => {
              current.gallery.push(media.url);
              renderGallery();
              markDirty();
            });
          }),
      }),
    ]);

    /* 正文 */
    const bodyField =
      current.mode === 'developer'
        ? field(
            '整页 HTML',
            textArea(current.html, '<!doctype html>\n<html>…</html>', 18, (value) => {
              current.html = value;
            }),
            '支持 <style> / <script>。前台会用沙箱 iframe 渲染，站点导航不受影响。',
          )
        : field(
            'README（Markdown）',
            textArea(current.readme, '# 标题\n\n正文…', 18, (value) => {
              current.readme = value;
            }),
            '支持标题、列表、引用、围栏代码块、链接、图片、加粗与行内代码。',
          );

    /* 发布 / 排序 */
    const publishToggle = el('input', { attrs: { type: 'checkbox' } });
    publishToggle.checked = current.published;
    publishToggle.addEventListener('change', () => {
      current.published = publishToggle.checked;
      markDirty();
    });
    const publishField = el('label', { className: 'wks__check' }, [
      publishToggle,
      el('span', { className: 'wks__label', text: '发布到前台' }),
      el('span', { className: 'wks__hint', text: '不勾选就只是草稿，前台列表与首页作品墙都看不到。' }),
    ]);

    const orderInput = el('input', { className: 'admin-input wks__order-input', attrs: { type: 'number', min: '0' } });
    orderInput.value = String(current.order);
    orderInput.addEventListener('input', () => {
      const value = Number(orderInput.value);
      if (Number.isFinite(value) && value >= 0) {
        current.order = Math.trunc(value);
        markDirty();
      }
    });

    const form = el('div', { className: 'wks__form' }, [
      seg,
      field('标题', titleInput),
      field('Slug（链接地址）', el('div', { className: 'wks__slugrow' }, [slugInput, regenerate]), '小写字母、数字与连字符；同名会冲突。'),
      field('简介', summaryInput),
      el('div', { className: 'wks__grid2' }, [field('年份', yearInput), field('分类', categoryInput)]),
      field('标签', tagsInput, '逗号分隔，最多 8 个。'),
      el('div', { className: 'wks__grid2' }, [field('源码地址', repoInput), field('预览地址', demoInput)]),
      field('缩略图', el('div', { className: 'wks__mediabox' }, [coverPreview, coverActions])),
      field('图集', el('div', { className: 'wks__mediabox' }, [galleryList, galleryActions])),
      bodyField,
      el('div', { className: 'wks__grid2' }, [publishField, field('排序（小的在前）', orderInput)]),
    ]);

    renderPreview();

    const grid = el('div', { className: 'wks__editor-grid' }, [form, previewBox]);
    editorHost.replaceChildren(editorHead, grid, editorFoot);
    editorHost.hidden = false;
    markDirty();
  }

  /** 与后端一致的 slug 规则（拉丁化失败时用时间戳兜底，和 `validate.slugify` 同一套）。 */
  function suggestSlug(title: string): string {
    const ascii = title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
    return ascii || `work-${Date.now().toString(36)}`;
  }

  let slugTouched = false;

  function switchMode(mode: WorkMode): void {
    if (!draft || draft.mode === mode) return;
    const hasOther = mode === 'developer' ? draft.readme.trim().length > 0 : draft.html.trim().length > 0;
    if (hasOther) {
      const sure = window.confirm(
        '切换模式会清空另一侧的内容（模板模式的 README / 开发者模式的 HTML）。继续？',
      );
      if (!sure) return;
      draft.readme = '';
      draft.html = '';
    }
    draft.mode = mode;
    renderEditor();
    markDirty();
  }

  function openEditor(work: AdminWork | null): void {
    if (draft && snapshot(draft) !== savedSnapshot) {
      if (!window.confirm('当前编辑还没保存，确定要放弃吗？')) return;
    }
    draft = work ? draftFrom(work) : emptyDraft();
    isNew = work === null;
    slugTouched = !isNew;
    savedSnapshot = snapshot(draft);
    list.hidden = true;
    createButton.disabled = true;
    refreshButton.disabled = true;
    renderEditor();
    setStatus('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeEditor(force = false): void {
    if (!draft) return;
    if (!force && snapshot(draft) !== savedSnapshot) {
      if (!window.confirm('当前编辑还没保存，确定要放弃吗？')) return;
    }
    draft = null;
    editorHost.hidden = true;
    editorHost.replaceChildren();
    previewFrame = null;
    list.hidden = false;
    createButton.disabled = false;
    refreshButton.disabled = false;
    setStatus('');
  }

  async function save(): Promise<void> {
    if (!draft || busy) return;
    if (!draft.title.trim()) {
      setStatus('标题不能为空。', 'error');
      return;
    }

    busy = true;
    saveButton.disabled = true;
    editorFootStatus.textContent = '正在保存…';

    const input = inputFrom(draft);
    const result = isNew ? await source.create(input) : await source.update(draft.id ?? '', input);

    busy = false;
    if (closed) return;

    if (!result.ok) {
      editorFootStatus.textContent = '';
      setStatus(result.message, 'error');
      markDirty();
      return;
    }

    const saved = result.data.work;
    works = isNew ? [...works, saved] : works.map((item) => (item.id === saved.id ? saved : item));
    isNew = false;
    draft = draftFrom(saved);
    slugTouched = true;
    savedSnapshot = snapshot(draft);
    editorFootStatus.textContent = `已保存 · ${formatDateTime(new Date(saved.updatedAt).getTime())}`;
    renderList();
    renderEditor();
    setStatus('已保存。前台刷新即可看到。', 'ok');
  }

  void reload();

  return {
    element,
    dispose: () => {
      closed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      if (previewTimer) window.clearTimeout(previewTimer);
      // iframe 里可能正在跑作者写的脚本：先清 srcdoc 让它导航到 about:blank。
      if (previewFrame) previewFrame.srcdoc = '';
    },
  };
}
