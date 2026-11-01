/**
 * 「留言」页（`#message`）。
 *
 * 结构照着 `pages/blog-post.ts`：先建壳、后填数据（路由 `start()` 必须同步产出首帧），
 * 三态打在 `section.dataset.state` 上，`dispose()` 里 `closed` + `abort` + 退订。
 *
 * 这块最特别的一处是**编辑器只有一个**：它平时住在页头的 `.mb-compose-slot` 里，用户点
 * 某条留言的「回复」时，它被 `append` 到那张卡片下面（DOM 搬家，不重建）。好处是游客的
 * 人机验证与已选图片不会因为换了个回复对象而白算一遍。见 `message/composer.ts` 顶部。
 */

import { subscribe } from '../auth/session';
import { MESSAGE_COPY, MESSAGE_TITLE_SUFFIX } from '../content/message';
import {
  fetchMessages,
  postMessage,
  postReply,
  requestCaptcha,
  type Outcome,
} from '../message/api';
import { createMessageCard, type MessageCardHandle, type ReplyTarget } from '../message/card';
import { closeLightbox } from '../message/lightbox';
import { createComposer, type ComposerHandle } from '../message/composer';
import type { ComposerSubmitInput, MessageView, PostedResult } from '../message/types';
import type { RouteView } from '../router';

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

interface PageState {
  messages: MessageView[];
  cursor: string | null;
  total: number;
  replyTotal: number;
  status: 'loading' | 'ready' | 'error';
  more: 'idle' | 'loading' | 'error';
  message: string;
}

export function createMessagePage(): RouteView {
  const section = el('section', 'message-board');
  section.dataset.state = 'loading';
  const inner = el('div', 'mb-inner');

  /* 页头 ---------------------------------------------------------------- */
  const head = el('header', 'mb-head');
  head.append(
    el('p', 'mb-kicker', MESSAGE_COPY.kicker),
    el('h1', 'mb-title', MESSAGE_COPY.title),
    el('p', 'mb-intro', MESSAGE_COPY.intro),
  );
  const stats = el('p', 'mb-stats');
  head.append(stats);

  /* 编辑器位置、状态行、列表、加载更多 ------------------------------------ */
  const slot = el('div', 'mb-compose-slot');

  const statusLine = el('p', 'mb-status');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  statusLine.hidden = true;

  const empty = el('p', 'mb-empty', MESSAGE_COPY.empty);
  empty.hidden = true;

  const list = el('ol', 'mb-list');

  const more = el('button', 'bl-btn bl-btn--ghost mb-more', MESSAGE_COPY.loadMore);
  more.type = 'button';
  more.hidden = true;

  inner.append(head, slot, statusLine, empty, list, more);
  section.append(inner);

  let closed = false;
  const abort = new AbortController();
  const baseTitle = document.title;
  let unsubscribe: (() => void) | null = null;
  let composer: ComposerHandle | null = null;

  const cards = new Map<string, MessageCardHandle>();

  const state: PageState = {
    messages: [],
    cursor: null,
    total: 0,
    replyTotal: 0,
    status: 'loading',
    more: 'idle',
    message: '',
  };

  /* 状态与统计 ------------------------------------------------------------ */

  function setStatus(text: string, tone: 'info' | 'error' = 'info', onRetry?: () => void): void {
    statusLine.replaceChildren();
    statusLine.classList.toggle('is-error', tone === 'error');
    if (!text) {
      statusLine.hidden = true;
      return;
    }
    statusLine.hidden = false;
    statusLine.append(document.createTextNode(text));
    if (onRetry) {
      const retry = el('button', 'mb-status__retry', MESSAGE_COPY.retry);
      retry.type = 'button';
      retry.addEventListener('click', onRetry);
      statusLine.append(retry);
    }
  }

  function paintStats(): void {
    const parts: string[] = [];
    if (state.total > 0) parts.push(`${state.total} ${MESSAGE_COPY.statMessages}`);
    if (state.replyTotal > 0) parts.push(`${state.replyTotal} ${MESSAGE_COPY.statReplies}`);
    stats.textContent = parts.join(' · ');
  }

  /** 把编辑器搬回页头（回复完、或列表重建之前必须调用，否则它会被一起清掉）。 */
  function returnComposer(): void {
    if (!composer) return;
    if (composer.element.parentElement !== slot) slot.append(composer.element);
  }

  /* 列表 ------------------------------------------------------------------ */

  function mountCard(message: MessageView): MessageCardHandle {
    const card = createMessageCard({
      message,
      onReply: (target) => startReply(message, target),
    });
    cards.set(message.id, card);
    return card;
  }

  function renderAll(): void {
    returnComposer();
    cards.clear();
    list.replaceChildren();
    for (const message of state.messages) list.append(mountCard(message).element);
    empty.hidden = state.messages.length > 0;
    paintStats();
    paintMore();
    section.dataset.state = state.status;
  }

  function paintMore(): void {
    more.hidden = state.status !== 'ready' || state.cursor === null;
    more.disabled = state.more === 'loading';
    more.textContent =
      state.more === 'loading'
        ? MESSAGE_COPY.loadMoreLoading
        : state.more === 'error'
          ? MESSAGE_COPY.loadMoreError
          : MESSAGE_COPY.loadMore;
  }

  /* 回复 ------------------------------------------------------------------ */

  function startReply(target: MessageView, info: ReplyTarget): void {
    if (!composer) return;
    const card = cards.get(target.id);
    if (!card) return;
    composer.setTarget(info);
    card.element.append(composer.element);
    composer.focus();
  }

  /* 数据 ------------------------------------------------------------------ */

  async function load(): Promise<void> {
    state.status = 'loading';
    state.more = 'idle';
    section.dataset.state = 'loading';
    setStatus(MESSAGE_COPY.loading);

    const result = await fetchMessages('', abort.signal);
    if (closed) return;

    if (!result.ok) {
      state.status = 'error';
      state.message = result.message || MESSAGE_COPY.error;
      section.dataset.state = 'error';
      setStatus(state.message, 'error', () => void load());
      paintMore();
      return;
    }

    state.messages = result.data.messages;
    state.cursor = result.data.nextCursor;
    state.total = result.data.total;
    state.replyTotal = result.data.replyTotal;
    state.status = 'ready';
    setStatus('');
    renderAll();
  }

  async function loadMore(): Promise<void> {
    if (state.more === 'loading' || state.cursor === null) return;
    state.more = 'loading';
    paintMore();

    const result = await fetchMessages(state.cursor, abort.signal);
    if (closed) return;

    if (!result.ok) {
      state.more = 'error';
      paintMore();
      return;
    }

    const known = new Set(state.messages.map((message) => message.id));
    for (const message of result.data.messages) {
      if (known.has(message.id)) continue;
      state.messages.push(message);
      list.append(mountCard(message).element);
    }
    state.cursor = result.data.nextCursor;
    state.total = result.data.total;
    state.replyTotal = result.data.replyTotal;
    state.more = 'idle';
    paintStats();
    paintMore();
  }

  more.addEventListener('click', () => void loadMore());

  /* 提交 ------------------------------------------------------------------ */

  /**
   * 提交：发新留言与发回复是两条接口，返回值形状也不同，这里统一成 `PostedResult`，
   * 让 `onPosted` 只需要关心「是留言还是回复」。
   */
  async function submit(input: ComposerSubmitInput): Promise<Outcome<PostedResult>> {
    if (!input.targetId) {
      const result = await postMessage(input);
      if (!result.ok) return result;
      return { ok: true, data: { kind: 'message', message: result.data.message, total: result.data.total } };
    }

    const parentId = input.targetId;
    const result = await postReply(parentId, input);
    if (!result.ok) return result;
    return {
      ok: true,
      data: {
        kind: 'reply',
        reply: result.data.reply,
        replyCount: result.data.replyCount,
        parentId,
      },
    };
  }

  function onPosted(result: PostedResult): void {
    returnComposer();

    if (result.kind === 'reply') {
      cards.get(result.parentId)?.appendReply(result.reply);
      // 回复数变了，页头统计跟着走。
      state.replyTotal += 1;
      paintStats();
      return;
    }

    state.messages.unshift(result.message);
    state.total = result.total;
    empty.hidden = true;
    list.prepend(mountCard(result.message).element);
    paintStats();
    // 刚发的留言在列表最上面，滚过去让人确认一眼真的发出去了。
    list.firstElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  composer = createComposer({
    submit,
    requestCaptcha,
    onPosted,
    onTargetCleared: () => returnComposer(),
  });
  slot.append(composer.element);

  unsubscribe = subscribe((next) => composer?.setAuth(next));

  document.title = `${MESSAGE_COPY.title}${MESSAGE_TITLE_SUFFIX}`;
  void load();

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      abort.abort();
      unsubscribe?.();
      unsubscribe = null;
      composer?.dispose();
      composer = null;
      cards.clear();
      closeLightbox();
      document.title = baseTitle;
    },
  };
}
