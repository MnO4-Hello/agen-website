/**
 * 留言编辑器（一个组件，两种形态）。
 *
 * 形态不是「两套组件」，而是同一个表单：
 *   · **发新留言**：顶部常驻，有「简单 / Markdown」两个 tab；
 *   · **回复某条**：被页面搬到那张卡片下面，tab 隐藏、强制纯文本（+ 图片），引用条显示
 *     「回复 游客 #3」。
 *
 * 为什么只做一个实例：游客的证明题**一道只能用一次**，图片队列也只有一份。给每条留言
 * 各配一个编辑器，等于要维护 N 份「验证算到 37%」的中间状态，且用户在 A 卡算完跑到 B 卡
 * 还得重算。搬 DOM 的代价只是丢一次焦点，划算得多。
 *
 * 三种身份的三种形态（与 `blog/reply-form.ts` 完全一致，别写歪）：
 *   · **登录用户**：不出现验证区，提交时也不带 `captcha`；
 *   · **游客**：出现验证区，**首次聚焦输入框时自动开始**算——用户打字的这几秒里浏览器
 *     已经在后台算完了；
 *   · **还没确认登录态**（`unknown`，通常几十毫秒）：先禁用提交。
 */

import type { AuthState } from '../auth/session';
import { solvePuzzle } from '../blog/pow';
import { MESSAGE_COPY } from '../content/message';
import { uploadImage, type Outcome } from './api';
import { compressImage } from './compress';
import { renderMessageMarkdown } from './markdown';
import type {
  Challenge,
  ComposerSubmitInput,
  MessageMode,
  PostedResult,
  Solution,
} from './types';

const MAX_TEXT = 2000;
const MAX_MARKDOWN = 8000;
const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;

export interface ComposerTarget {
  id: string;
  nickname: string;
  floor: number | null;
}

export interface ComposerOptions {
  submit: (input: ComposerSubmitInput) => Promise<Outcome<PostedResult>>;
  /** 领一道工作量证明题（`GET /api/messages/captcha`）。失败返回 `null`。 */
  requestCaptcha: () => Promise<Challenge | null>;
  onPosted: (result: PostedResult) => void;
  /** 用户主动点了「取消引用」：页面据此把编辑器搬回原位。 */
  onTargetCleared: () => void;
}

export interface ComposerHandle {
  element: HTMLFormElement;
  setAuth(state: AuthState): void;
  setTarget(target: ComposerTarget | null): void;
  focus(): void;
  dispose(): void;
}

interface Shot {
  key: number;
  /** 服务端返回的文件名；上传完成前为空串。 */
  name: string;
  /** 本地预览地址（`URL.createObjectURL`）。 */
  preview: string;
  state: 'uploading' | 'ready' | 'error';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createComposer(options: ComposerOptions): ComposerHandle {
  let closed = false;
  let auth: AuthState = { status: 'unknown' };
  let busy = false;
  let mode: MessageMode = 'text';
  let previewing = false;
  let target: ComposerTarget | null = null;
  let statusTimer = 0;
  let uploadSeq = 0;
  const shots: Shot[] = [];

  /** 已经算好的解；`null` = 还没验证过。一张题只能用一次。 */
  let solution: Solution | null = null;
  let pending: Promise<Solution | null> | null = null;
  let verifyPercent = 0;
  const verifyAbort = new AbortController();
  let started = false;

  const form = el('form', 'mb-compose');
  form.noValidate = true;

  /* 引用条 ---------------------------------------------------------------- */
  const quote = el('div', 'mb-compose__quote');
  quote.hidden = true;
  const quoteText = el('span', 'mb-compose__quote-text');
  const quoteCancel = el('button', 'mb-compose__quote-cancel', MESSAGE_COPY.cancelQuote);
  quoteCancel.type = 'button';
  quote.append(quoteText, quoteCancel);

  /* 模式切换 -------------------------------------------------------------- */
  const tabs = el('div', 'mb-compose__tabs');
  const tabText = el('button', 'mb-tab is-active', MESSAGE_COPY.modeText);
  const tabMarkdown = el('button', 'mb-tab', MESSAGE_COPY.modeMarkdown);
  tabText.type = 'button';
  tabMarkdown.type = 'button';
  tabs.append(tabText, tabMarkdown);

  /* 正文 ------------------------------------------------------------------ */
  const textarea = el('textarea', 'mb-input');
  textarea.rows = 4;
  textarea.maxLength = MAX_TEXT;
  textarea.placeholder = MESSAGE_COPY.placeholderText;
  textarea.setAttribute('aria-label', '留言正文');

  const mdTools = el('div', 'mb-md-tools');
  mdTools.hidden = true;

  function tool(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', 'mb-tool', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  const preview = el('div', 'mb-preview md-body');
  preview.hidden = true;

  const field = el('div', 'mb-compose__field');
  field.append(textarea, mdTools, preview);

  /* 图片 ------------------------------------------------------------------ */
  const files = el('div', 'mb-files');
  const addButton = el('button', 'mb-add');
  addButton.type = 'button';
  addButton.append(el('span', 'mb-add__icon', '+'), el('span', undefined, MESSAGE_COPY.imageAdd));

  const picker = el('input', 'mb-picker');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
  picker.multiple = true;
  picker.hidden = true;
  picker.tabIndex = -1;

  /* 验证区 ---------------------------------------------------------------- */
  const verifyBox = el('div', 'mb-verify');
  verifyBox.dataset.state = 'idle';
  verifyBox.setAttribute('role', 'status');
  verifyBox.setAttribute('aria-live', 'polite');
  const verifyText = el('span', 'mb-verify__text');
  const verifyBar = el('span', 'mb-verify__bar');
  const verifyFill = el('i', 'mb-verify__fill');
  verifyBar.append(verifyFill);
  const verifyRetry = el('button', 'mb-verify__retry', MESSAGE_COPY.verifyRetry);
  verifyRetry.type = 'button';
  verifyRetry.hidden = true;
  verifyBox.append(verifyText, verifyBar, verifyRetry);

  /* 蜜罐：视觉上挪出屏幕，`display:none` 会被一部分脚本直接跳过 ------------- */
  const honeypot = el('input', 'mb-hp');
  honeypot.type = 'text';
  honeypot.name = 'website';
  honeypot.tabIndex = -1;
  honeypot.autocomplete = 'off';
  honeypot.setAttribute('aria-hidden', 'true');

  /* 底栏 ------------------------------------------------------------------ */
  const foot = el('div', 'mb-compose__foot');
  const note = el('span', 'mb-note');
  const count = el('span', 'mb-count');
  const submit = el('button', 'bl-btn mb-submit', MESSAGE_COPY.submit);
  submit.type = 'submit';
  foot.append(note, count, submit);

  const status = el('p', 'mb-compose__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  form.append(quote, tabs, field, files, picker, verifyBox, honeypot, foot, status);

  /* 状态渲染 -------------------------------------------------------------- */

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', tone === 'error');
    status.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    // 成功提示自动淡出；错误留着等下一次操作覆盖——它通常需要人看见。
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        status.textContent = '';
        status.hidden = true;
      }, 4000);
    }
  }

  function readyShots(): Shot[] {
    return shots.filter((shot) => shot.state === 'ready');
  }

  function bodyLength(): number {
    return Array.from(textarea.value).length;
  }

  function updateCount(): void {
    const max = mode === 'markdown' ? MAX_MARKDOWN : MAX_TEXT;
    const length = bodyLength();
    count.textContent = `${length} / ${max}`;
    count.classList.toggle('is-over', length > max);
  }

  function canSubmit(): boolean {
    if (busy || auth.status === 'unknown') return false;
    // 禁言中一律不能提交（包括「只有图没有字」那条路）：服务端也会拒，这里只是别让人白填。
    if (auth.status === 'user' && auth.moderation) return false;
    if (shots.some((shot) => shot.state === 'uploading')) return false;
    const length = bodyLength();
    if (mode === 'markdown') return length >= 2;
    // 简单模式允许「只有图、没有字」——图本身就是内容。
    return length >= 2 || readyShots().length > 0;
  }

  function refreshMeta(): void {
    const guest = auth.status === 'guest';
    const unknown = auth.status === 'unknown';
    const mute = auth.status === 'user' ? auth.moderation : null;
    note.classList.toggle('is-muted', Boolean(mute));
    if (unknown) note.textContent = '正在确认登录状态…';
    else if (guest) note.textContent = MESSAGE_COPY.guestNotice;
    else if (mute) {
      /*
       * 禁言提示写在「提交区」而不是弹一个 toast：它要一直看得见，否则用户会以为
       * 是自己网卡了、反复点提交。到期时间与原因都由服务端排好版下发。
       */
      const when = mute.mutedLabel === '永久' ? '永久' : `至 ${mute.mutedLabel}`;
      note.textContent = `你已被禁言${when}${mute.mutedReason ? `（原因：${mute.mutedReason}）` : ''}，暂时不能留言。`;
    } else note.textContent = '';

    submit.disabled = !canSubmit();
    submit.textContent = busy
      ? MESSAGE_COPY.submitting
      : target
        ? MESSAGE_COPY.submitReply
        : MESSAGE_COPY.submit;
    updateCount();
  }

  /** 验证区的四种形态。真实判定在服务端，这里只负责别让用户猜。 */
  function paintVerify(state: 'idle' | 'working' | 'ready' | 'error', text?: string): void {
    verifyBox.dataset.state = state;
    verifyBox.classList.toggle('is-ok', state === 'ready');
    verifyBox.classList.toggle('is-error', state === 'error');
    // 游客且真的开始验证了才占位：空着的一颗虚线药丸比什么都不显示更让人困惑。
    verifyBox.hidden = auth.status !== 'guest' || state === 'idle';
    verifyBar.hidden = state !== 'working';
    verifyRetry.hidden = state !== 'error';
    verifyFill.style.width = `${verifyPercent}%`;

    if (text) {
      verifyText.textContent = text;
      return;
    }
    if (state === 'working') verifyText.textContent = `${MESSAGE_COPY.verifyWorking} ${verifyPercent}%`;
    else if (state === 'ready') verifyText.textContent = MESSAGE_COPY.verifyDone;
    else if (state === 'error') verifyText.textContent = MESSAGE_COPY.verifyFailed;
    else verifyText.textContent = '';
  }

  /* 模式 ------------------------------------------------------------------ */

  function syncPreview(): void {
    preview.replaceChildren();
    if (previewing) preview.append(renderMessageMarkdown(textarea.value));
    textarea.hidden = previewing;
    preview.hidden = !previewing;
  }

  function setMode(next: MessageMode): void {
    mode = next;
    tabText.classList.toggle('is-active', mode === 'text');
    tabMarkdown.classList.toggle('is-active', mode === 'markdown');
    textarea.placeholder =
      mode === 'markdown' ? MESSAGE_COPY.placeholderMarkdown : MESSAGE_COPY.placeholderText;
    textarea.maxLength = mode === 'markdown' ? MAX_MARKDOWN : MAX_TEXT;

    const markdown = mode === 'markdown';
    mdTools.hidden = !markdown;
    files.hidden = markdown;
    tabs.hidden = target !== null;
    // 切回简单模式时预览必须关掉，否则编辑区被藏起来的是一份看不见的 DOM。
    if (!markdown) previewing = false;
    previewToggle.textContent = previewing ? MESSAGE_COPY.editTab : MESSAGE_COPY.previewTab;
    syncPreview();
    refreshMeta();
  }

  /* 图片 ------------------------------------------------------------------ */

  function renderFiles(): void {
    files.replaceChildren(...shots.map((shot) => tile(shot)), addButton);
    files.hidden = mode === 'markdown';
  }

  function removeShot(shot: Shot): void {
    const at = shots.indexOf(shot);
    if (at >= 0) shots.splice(at, 1);
    if (shot.preview.startsWith('blob:')) URL.revokeObjectURL(shot.preview);
    renderFiles();
    refreshMeta();
  }

  function tile(shot: Shot): HTMLElement {
    const box = el('div', `mb-file is-${shot.state}`);
    const img = el('img', 'mb-file__img');
    img.src = shot.preview;
    img.alt = '';
    img.loading = 'lazy';

    const remove = el('button', 'mb-file__remove', '×');
    remove.type = 'button';
    remove.title = shot.state === 'error' ? MESSAGE_COPY.imageFailed : '移除这张图';
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => removeShot(shot));

    box.append(img, remove);
    if (shot.state === 'uploading') box.append(el('span', 'mb-file__hint', MESSAGE_COPY.imageUploading));
    if (shot.state === 'error') box.append(el('span', 'mb-file__hint', MESSAGE_COPY.imageFailed));
    return box;
  }

  async function addOne(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      setStatus(MESSAGE_COPY.imageBadType, 'error');
      return;
    }
    const shot: Shot = {
      key: (uploadSeq += 1),
      name: '',
      preview: URL.createObjectURL(file),
      state: 'uploading',
    };
    shots.push(shot);
    renderFiles();
    refreshMeta();

    const blob = await compressImage(file);
    if (closed) return;
    if (blob.size > MAX_BYTES) {
      shot.state = 'error';
      renderFiles();
      refreshMeta();
      setStatus(MESSAGE_COPY.imageTooBig, 'error');
      return;
    }

    const result = await uploadImage(blob);
    if (closed) return;
    if (!result.ok) {
      shot.state = 'error';
      renderFiles();
      refreshMeta();
      setStatus(result.message || MESSAGE_COPY.imageFailed, 'error');
      return;
    }
    shot.name = result.data.name;
    shot.state = 'ready';
    renderFiles();
    refreshMeta();
  }

  function addFiles(list: FileList | File[]): void {
    const filesArray = Array.from(list);
    if (filesArray.length === 0) return;
    const room = MAX_IMAGES - shots.length;
    if (room <= 0) {
      setStatus(MESSAGE_COPY.imageLimit, 'error');
      return;
    }
    if (filesArray.length > room) setStatus(MESSAGE_COPY.imageLimit, 'error');
    for (const file of filesArray.slice(0, room)) void addOne(file);
  }

  /** 把一段文本插到光标处，并手动派发 `input`（字数/按钮状态都靠它）。 */
  function insertAtCursor(text: string): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  /** Markdown 模式：上传后插入 `![](/api/messages/media/m-xxx.png)`。 */
  async function insertImageMarkdown(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      setStatus(MESSAGE_COPY.imageBadType, 'error');
      return;
    }
    const blob = await compressImage(file);
    if (closed) return;
    if (blob.size > MAX_BYTES) {
      setStatus(MESSAGE_COPY.imageTooBig, 'error');
      return;
    }
    setStatus('正在上传图片…');
    const result = await uploadImage(blob);
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message || MESSAGE_COPY.imageFailed, 'error');
      return;
    }
    const before = textarea.value.slice(0, textarea.selectionStart);
    const prefix = before && !before.endsWith('\n') ? '\n' : '';
    insertAtCursor(`${prefix}![](${result.data.url})\n`);
    setStatus('图片已插入。', 'ok');
  }

  /* 选图：同一个隐藏 input，两种用法 ---------------------------------------- */

  /** `fill` = 塞进图片队列（简单模式）；`insert` = 插进正文（Markdown 模式）。 */
  let pickMode: 'fill' | 'insert' = 'fill';

  function openPicker(next: 'fill' | 'insert'): void {
    pickMode = next;
    picker.multiple = next === 'fill';
    picker.value = '';
    picker.click();
  }

  picker.addEventListener('change', () => {
    const list = picker.files;
    if (!list || list.length === 0) return;
    if (pickMode === 'insert') {
      const file = list[0];
      if (file) void insertImageMarkdown(file);
      return;
    }
    addFiles(list);
  });

  addButton.addEventListener('click', () => openPicker('fill'));

  /* 工具栏 ---------------------------------------------------------------- */

  const previewToggle = el('button', 'mb-tool mb-tool--preview', MESSAGE_COPY.previewTab);
  previewToggle.type = 'button';
  previewToggle.addEventListener('click', () => {
    previewing = !previewing;
    previewToggle.textContent = previewing ? MESSAGE_COPY.editTab : MESSAGE_COPY.previewTab;
    syncPreview();
  });

  mdTools.append(
    tool('B', MESSAGE_COPY.toolBold, () => wrapSelection('**', '**')),
    tool('“', MESSAGE_COPY.toolQuote, () => insertAtCursor('\n> ')),
    tool('</>', MESSAGE_COPY.toolCode, () => wrapSelection('`', '`')),
    tool('链接', MESSAGE_COPY.toolLink, () => insertAtCursor('[](https://)')),
    tool('图片', MESSAGE_COPY.toolImage, () => openPicker('insert')),
    previewToggle,
  );

  function wrapSelection(before: string, after: string): void {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    textarea.setRangeText(`${before}${selected}${after}`, start, end, 'end');
    if (selected.length === 0) {
      // 没选中就把光标放到标记中间，直接开始打。
      textarea.selectionStart = start + before.length;
      textarea.selectionEnd = start + before.length;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  tabText.addEventListener('click', () => setMode('text'));
  tabMarkdown.addEventListener('click', () => setMode('markdown'));

  /* 验证 ------------------------------------------------------------------ */

  function resetVerify(): void {
    solution = null;
    pending = null;
    verifyPercent = 0;
    started = false;
    paintVerify('idle');
  }

  /**
   * 领题 → 算 → 存起来。并发调用共用 `pending`：用户连点两次提交，也只会算一次。
   */
  function ensureVerified(): Promise<Solution | null> {
    if (solution) return Promise.resolve(solution);
    if (pending) return pending;
    if (closed || auth.status !== 'guest') return Promise.resolve(null);

    started = true;
    verifyPercent = 0;
    paintVerify('working');

    pending = (async (): Promise<Solution | null> => {
      const challenge = await options.requestCaptcha();
      const fetchedAt = Date.now();
      if (closed) return null;
      if (!challenge) {
        paintVerify('error');
        return null;
      }

      try {
        const solved = await solvePuzzle(challenge, {
          signal: verifyAbort.signal,
          onProgress: (percent) => {
            if (closed) return;
            verifyPercent = percent;
            paintVerify('working');
          },
        });
        if (closed) return null;

        /*
         * 服务端要求「签发后至少过 minElapsedMs 才收」。机器算得快的时候（实测 0.1 秒），
         * 用户手一快就会撞上 too_fast；这里把差额等掉。
         */
        const remaining = fetchedAt + challenge.minElapsedMs - Date.now();
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        if (closed) return null;

        solution = solved;
        paintVerify('ready', `${MESSAGE_COPY.verifyDone} · ${(solved.took / 1000).toFixed(1)}s`);
        return solved;
      } catch (error) {
        if (closed) return null;
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        paintVerify('error');
        return null;
      } finally {
        pending = null;
      }
    })();

    return pending;
  }

  verifyRetry.addEventListener('click', () => {
    resetVerify();
    void ensureVerified();
  });

  textarea.addEventListener('focus', () => {
    if (started || busy) return;
    if (auth.status !== 'guest') return;
    void ensureVerified();
  });

  textarea.addEventListener('input', () => {
    updateCount();
    refreshMeta();
    if (previewing) syncPreview();
  });

  textarea.addEventListener('paste', (event) => {
    const list = Array.from(event.clipboardData?.files ?? []);
    if (list.length === 0) return;
    event.preventDefault();
    if (mode === 'markdown') {
      // Markdown 模式的图要落进正文，逐张传完插入。
      for (const file of list) void insertPastedImage(file);
      return;
    }
    addFiles(list);
  });

  async function insertPastedImage(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) return;
    const blob = await compressImage(file);
    if (closed) return;
    const result = await uploadImage(blob);
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message || MESSAGE_COPY.imageFailed, 'error');
      return;
    }
    insertAtCursor(`![](${result.data.url})\n`);
  }

  form.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    form.classList.add('is-over');
  });
  form.addEventListener('dragleave', () => form.classList.remove('is-over'));
  form.addEventListener('drop', (event) => {
    form.classList.remove('is-over');
    const list = Array.from(event.dataTransfer?.files ?? []);
    if (list.length === 0) return;
    event.preventDefault();
    if (mode === 'markdown') {
      for (const file of list) void insertPastedImage(file);
      return;
    }
    addFiles(list);
  });

  /* 引用 ------------------------------------------------------------------ */

  function clearTarget(notify: boolean): void {
    if (!target) return;
    target = null;
    quote.hidden = true;
    quoteText.textContent = '';
    tabs.hidden = false;
    mdTools.hidden = mode !== 'markdown';
    if (notify) options.onTargetCleared();
    refreshMeta();
  }

  function setTarget(next: ComposerTarget | null): void {
    if (!next) {
      clearTarget(false);
      return;
    }
    target = next;
    quoteText.textContent = `${MESSAGE_COPY.quoteTo} ${next.nickname}${
      next.floor ? ` #${next.floor}` : ''
    }`;
    quote.hidden = false;
    tabs.hidden = true;
    mdTools.hidden = true;
    // 回复只有纯文本 + 图片。
    if (mode !== 'text') setMode('text');
    refreshMeta();
  }

  quoteCancel.addEventListener('click', () => clearTarget(true));

  /* 提交 ------------------------------------------------------------------ */

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void post();
  });

  async function post(): Promise<void> {
    if (closed || busy || auth.status === 'unknown') return;

    const body = textarea.value.trim();
    const images = mode === 'markdown' ? [] : readyShots().map((shot) => shot.name);

    if (shots.some((shot) => shot.state === 'uploading')) {
      setStatus('图片还在上传，等一下再发。', 'error');
      return;
    }
    if (mode === 'markdown' && Array.from(body).length < 2) {
      setStatus(MESSAGE_COPY.tooShort, 'error');
      return;
    }
    if (mode === 'text' && Array.from(body).length < 2 && images.length === 0) {
      setStatus(MESSAGE_COPY.tooShort, 'error');
      return;
    }

    // 先锁住：避免「验证途中又点了一次」把同一张题提交两遍。
    busy = true;
    refreshMeta();

    let captcha: Solution | null = null;
    if (auth.status === 'guest') {
      captcha = await ensureVerified();
      if (closed) return;
      if (!captcha) {
        busy = false;
        refreshMeta();
        setStatus(MESSAGE_COPY.verifyBlocked, 'error');
        return;
      }
    }

    const result = await options.submit({
      targetId: target?.id ?? null,
      mode,
      body,
      images,
      captcha,
      honeypot: honeypot.value,
    });
    if (closed) return;

    busy = false;

    if (result.ok) {
      const wasReply = target !== null;
      textarea.value = '';
      honeypot.value = '';
      for (const shot of shots.splice(0)) {
        if (shot.preview.startsWith('blob:')) URL.revokeObjectURL(shot.preview);
      }
      renderFiles();
      previewing = false;
      previewToggle.textContent = MESSAGE_COPY.previewTab;
      syncPreview();
      clearTarget(false);
      resetVerify();
      refreshMeta();
      setStatus(wasReply ? MESSAGE_COPY.replyPosted : MESSAGE_COPY.posted, 'ok');
      options.onPosted(result.data);
      return;
    }

    // 被主动取消：什么都不用做。
    if (!result.message) {
      refreshMeta();
      return;
    }

    // 验证相关的失败都重来一次（服务端可能已经把它消费掉了）。
    if (
      result.error === 'captcha_failed' ||
      result.error === 'captcha_expired' ||
      result.error === 'captcha_missing' ||
      result.error === 'too_fast'
    ) {
      resetVerify();
      if (auth.status === 'guest') void ensureVerified();
    }

    setStatus(result.message, 'error');
    refreshMeta();
  }

  /* 收尾 ------------------------------------------------------------------ */

  setMode('text');
  renderFiles();
  refreshMeta();

  return {
    element: form,
    setAuth(state) {
      const wasGuest = auth.status === 'guest';
      auth = state;
      refreshMeta();
      if (state.status === 'guest' && !wasGuest) resetVerify();
      if (state.status === 'user') {
        resetVerify();
        verifyBox.hidden = true;
      }
    },
    setTarget,
    focus() {
      textarea.focus({ preventScroll: false });
      form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    dispose() {
      closed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      verifyAbort.abort();
      for (const shot of shots) {
        if (shot.preview.startsWith('blob:')) URL.revokeObjectURL(shot.preview);
      }
      shots.length = 0;
    },
  };
}
