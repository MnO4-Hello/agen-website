/**
 * 后台「留言」：审核留言与回复、以站长身份回一句。
 *
 * 与 `post-replies.ts` 同一套纪律：
 *
 *   · **只有隐藏 / 恢复，没有删除**。隐藏是软删，前台显示「该留言已删除」；真删了就是
 *     一片查不出来的空洞，而且没有任何办法复原。
 *   · **后台看得到被隐藏的正文**（`toAdminMessageView` 不抹 body），否则「该不该恢复」
 *     这件事根本没法判断。
 *   · **没有弹窗**。项目里没有 modal，也不该为此引入：展开就是内联展开，可逆操作不进
 *     确认框，状态反馈走顶部那一行 `role="status"`。
 *
 * 一处与帖子回复不同的地方：留言本身就是顶层，所以列表直接分页，「回复」只是行内的一块。
 */

import {
  fetchAdminMessages,
  replyAsAdmin,
  setAdminMessageStatus,
  type AdminMessage,
  type AdminMessagePage,
  type AdminMessageStatus,
  type ApiResult,
} from '../api';
import { isOwner } from '../role';
import { button, el, formatDateTime } from '../ui';
import { renderMessageMarkdown } from '../../message/markdown';
import type { AdminView } from './view';

const EXCERPT_LENGTH = 120;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 数据源接口（与 `post-source.ts` 同一个思路）。
 *
 * 抽这一层不是为了「将来换后端」，是为了 `?preview=guestbook` 能用假数据把版面画出来——
 * 直接调真接口的话，DEV 截图通道里没有管理员 cookie，视图会 401 后把自己踢回登录页。
 */
export interface GuestbookSource {
  list(query: {
    status: string;
    q: string;
    cursor: string;
  }): Promise<ApiResult<AdminMessagePage>>;
  setStatus(id: string, status: AdminMessageStatus): Promise<ApiResult<{ message: AdminMessage }>>;
  reply(id: string, body: string): Promise<ApiResult<{ reply: AdminMessage; replyCount: number }>>;
}

export const liveGuestbookSource: GuestbookSource = {
  list: (query) => fetchAdminMessages(query),
  setStatus: (id, status) => setAdminMessageStatus(id, status),
  reply: (id, body) => replyAsAdmin(id, body),
};

export function createGuestbookView(source: GuestbookSource = liveGuestbookSource): AdminView {
  let closed = false;
  let busy = false;
  let timer = 0;
  let statusTimer = 0;

  const state = {
    messages: [] as AdminMessage[],
    cursor: null as string | null,
    total: 0,
    status: '' as '' | 'visible' | 'hidden',
    q: '',
    loading: false,
    more: false,
  };

  const expanded = new Set<string>();
  /** 站长回复的草稿：重画列表时不能把人家正打的字弄丢。 */
  const drafts = new Map<string, string>();

  /* 外壳 ---------------------------------------------------------------- */

  const root = el('div', { className: 'gbk' });

  /* 标题由外壳的顶栏负责（它已经写着「留言」），这里只留一句计数，不重复标题。 */
  const top = el('div', { className: 'gbk__top' });
  const count = el('span', { className: 'gbk__count', text: '' });
  const refresh = button({
    className: 'admin-btn admin-btn--ghost',
    text: '刷新',
    onClick: () => void load(true),
  });
  top.append(count, refresh);

  const filters = el('div', { className: 'gbk__filters' });
  const statusSelect = el('select', { className: 'admin-select', attrs: { 'aria-label': '按状态筛选' } });
  for (const [value, label] of [
    ['', '全部留言'],
    ['visible', '只看可见'],
    ['hidden', '只看已隐藏'],
  ] as const) {
    const option = el('option', { text: label, attrs: { value } });
    statusSelect.append(option);
  }
  const search = el('input', {
    className: 'admin-input admin-input--search',
    attrs: { type: 'search', placeholder: '搜留言内容或昵称…', 'aria-label': '搜索留言' },
  });
  filters.append(statusSelect, search);

  const statusLine = el('p', { className: 'gbk__status', attrs: { role: 'status', 'aria-live': 'polite' } });
  statusLine.hidden = true;

  const list = el('ul', { className: 'gbk__list' });

  const moreWrap = el('div', { className: 'gbk__more' });
  const moreButton = button({
    className: 'admin-btn',
    text: '加载更多',
    onClick: () => void loadMore(),
  });
  moreWrap.append(moreButton);
  moreWrap.hidden = true;

  root.append(top, filters, statusLine, list, moreWrap);

  /* 状态提示 ------------------------------------------------------------ */

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    statusLine.textContent = text;
    statusLine.hidden = !text;
    statusLine.classList.toggle('is-error', tone === 'error');
    statusLine.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    // 成功提示自动淡出；错误留着等下一次操作覆盖——它通常需要人看见。
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        statusLine.textContent = '';
        statusLine.hidden = true;
      }, 4000);
    }
  }

  /* 数据 ---------------------------------------------------------------- */

  async function load(silent = false): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    if (!silent) setStatus('正在读取留言…');

    const result = await source.list({ status: state.status, q: state.q, cursor: '' });
    state.loading = false;
    if (closed) return;

    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }

    state.messages = result.data.messages;
    state.cursor = result.data.nextCursor;
    state.total = result.data.total;
    setStatus('');
    render();
  }

  async function loadMore(): Promise<void> {
    if (state.more || state.cursor === null) return;
    state.more = true;
    moreButton.disabled = true;
    moreButton.textContent = '正在加载…';

    const result = await source.list({ status: state.status, q: state.q, cursor: state.cursor ?? '' });
    state.more = false;
    moreButton.disabled = false;
    moreButton.textContent = '加载更多';
    if (closed) return;

    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }

    const known = new Set(state.messages.map((message) => message.id));
    for (const message of result.data.messages) {
      if (!known.has(message.id)) state.messages.push(message);
    }
    state.cursor = result.data.nextCursor;
    state.total = result.data.total;
    render();
  }

  /* 操作 ---------------------------------------------------------------- */

  async function toggleStatus(message: AdminMessage): Promise<void> {
    if (busy) return;
    busy = true;
    const next = message.status === 'visible' ? 'hidden' : 'visible';
    const result = await source.setStatus(message.id, next);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    message.status = result.data.message.status;
    setStatus(next === 'hidden' ? '已隐藏这条留言。' : '已恢复这条留言。', 'ok');
    render();
  }

  async function submitReply(message: AdminMessage, input: HTMLTextAreaElement): Promise<void> {
    const body = input.value.trim();
    if (Array.from(body).length < 2) {
      setStatus('至少写两个字。', 'error');
      return;
    }
    if (busy) return;
    busy = true;
    const result = await source.reply(message.id, body);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    message.replies.push(result.data.reply);
    message.replyCount = result.data.replyCount;
    drafts.delete(message.id);
    setStatus('已作为站长回复。', 'ok');
    render();
  }

  /* 渲染 ---------------------------------------------------------------- */

  function excerptOf(message: AdminMessage): string {
    const text = message.mode === 'markdown' ? stripMarkdown(message.body) : message.body;
    const points = Array.from(text.replace(/\s+/g, ' ').trim());
    return points.length > EXCERPT_LENGTH ? `${points.slice(0, EXCERPT_LENGTH).join('')}…` : points.join('');
  }

  /** 摘要用：把 Markdown 语法符号去掉，只留字（不追求完整解析）。 */
  function stripMarkdown(source: string): string {
    return source
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/[*_`~]/g, '');
  }

  function metaPills(message: AdminMessage): HTMLElement[] {
    const pills: HTMLElement[] = [];
    if (message.author.owner) pills.push(el('span', { className: 'admin-pill is-on', text: '站长' }));
    if (message.author.deleted) pills.push(el('span', { className: 'admin-pill', text: '已注销' }));
    if (message.mode === 'markdown') pills.push(el('span', { className: 'admin-pill', text: 'Markdown' }));
    if (message.images.length > 0) {
      pills.push(el('span', { className: 'admin-pill', text: `${message.images.length} 张图` }));
    }
    if (message.status !== 'visible') pills.push(el('span', { className: 'admin-pill is-danger', text: '已隐藏' }));
    return pills;
  }

  function bodyNode(message: AdminMessage): HTMLElement {
    if (message.mode === 'markdown') {
      const box = el('div', { className: 'gbk__body md-body bpe__preview' });
      box.append(renderMessageMarkdown(message.body));
      return box;
    }
    return el('p', { className: 'gbk__body', text: message.body });
  }

  function detailNode(message: AdminMessage): HTMLElement {
    const detail = el('div', { className: 'gbk__detail' });

    if (message.body) detail.append(bodyNode(message));

    if (message.images.length > 0) {
      const shots = el('div', { className: 'gbk__shots' });
      for (const url of message.images) {
        const link = el('a', { className: 'gbk__shot', attrs: { href: url, target: '_blank', rel: 'noreferrer' } });
        link.append(el('img', { className: 'gbk__shot-img', attrs: { src: url, alt: '', loading: 'lazy' } }));
        shots.append(link);
      }
      detail.append(shots);
    }

    if (message.replies.length === 0) {
      // 已隐藏的留言下面还有一句「恢复之后才能回复」，两条空提示叠着看太吵，跳过这条。
      if (message.status === 'visible') {
        detail.append(el('p', { className: 'gbk__empty', text: '这条留言还没有回复。' }));
      }
    } else {
      const replies = el('ul', { className: 'gbk__replies' });
      for (const reply of message.replies) {
        const hidden = reply.status !== 'visible';
        const row = el('li', { className: `gbk__reply${hidden ? ' is-hidden' : ''}` });
        const meta = el('div', { className: 'gbk__reply-meta' });
        meta.append(el('span', { className: 'gbk__reply-name', text: reply.author.nickname }));
        if (reply.author.owner) meta.append(el('span', { className: 'admin-pill is-on', text: '站长' }));
        if (hidden) meta.append(el('span', { className: 'admin-pill is-danger', text: '已隐藏' }));
        if (reply.images.length > 0) {
          meta.append(el('span', { className: 'admin-pill', text: `${reply.images.length} 张图` }));
        }
        meta.append(
          el('span', { className: 'gbk__reply-time', text: formatDateTime(Date.parse(reply.createdAt)) }),
        );
        meta.append(
          button({
            className: `admin-btn${hidden ? '' : ' is-active'}`,
            text: hidden ? '恢复' : '隐藏',
            title: hidden ? '恢复为可见' : '隐藏（软删除，保留位置）',
            onClick: () => void toggleStatus(reply),
          }),
        );
        row.append(meta, el('p', { className: 'gbk__reply-body', text: reply.body }));
        if (reply.images.length > 0) {
          const shots = el('div', { className: 'gbk__shots' });
          for (const url of reply.images) {
            const link = el('a', {
              className: 'gbk__shot',
              attrs: { href: url, target: '_blank', rel: 'noreferrer' },
            });
            link.append(el('img', { className: 'gbk__shot-img', attrs: { src: url, alt: '', loading: 'lazy' } }));
            shots.append(link);
          }
          row.append(shots);
        }
        replies.append(row);
      }
      detail.append(replies);
    }

    /*
     * 站长回复。隐藏的留言不能回（服务端会拒），这里直接不给框，省一次报错。
     *
     * 管理员也不给：这条回复会以**站长身份**署名出现在前台，等于替站长说话。
     * 审核（隐藏/恢复）对管理员开放，署名发言不开放。
     */
    if (message.status !== 'visible') {
      detail.append(
        el('p', {
          className: 'gbk__empty',
          text: '这条留言已被隐藏，恢复之后才能回复。',
        }),
      );
      return detail;
    }
    if (!isOwner()) {
      detail.append(
        el('p', {
          className: 'gbk__empty',
          text: '只有站长能以站长身份回复；管理员可以隐藏/恢复留言。',
        }),
      );
      return detail;
    }

    const form = el('div', { className: 'gbk__replyform' });
    const input = el('textarea', {
      className: 'admin-input gbk__replyinput',
      attrs: { rows: '3', placeholder: '以站长身份回复…（纯文本，两字起）', 'aria-label': '站长回复' },
    });
    input.value = drafts.get(message.id) ?? '';
    input.addEventListener('input', () => drafts.set(message.id, input.value));
    const send = button({
      className: 'admin-btn admin-btn--primary',
      text: '回复',
      onClick: () => void submitReply(message, input),
    });
    form.append(input, send);
    detail.append(form);

    return detail;
  }

  function row(message: AdminMessage): HTMLElement {
    const hidden = message.status !== 'visible';
    const li = el('li', { className: `gbk__row${hidden ? ' is-hidden' : ''}` });

    const head = el('div', { className: 'gbk__rowhead' });
    head.append(el('span', { className: 'gbk__floor', text: message.floor === null ? '—' : `#${message.floor}` }));
    head.append(el('span', { className: 'gbk__name', text: message.author.nickname }));
    head.append(...metaPills(message));
    head.append(
      el('span', { className: 'gbk__time', text: formatDateTime(Date.parse(message.createdAt)) }),
    );
    head.append(
      el('span', {
        className: 'gbk__replies-count',
        text: message.replyCount > 0 ? `${message.replyCount} 条回复` : '',
      }),
    );

    const ops = el('div', { className: 'gbk__ops' });
    const isOpen = expanded.has(message.id);
    ops.append(
      button({
        className: 'admin-btn admin-btn--ghost',
        text: isOpen ? '收起' : '详情',
        onClick: () => {
          if (isOpen) expanded.delete(message.id);
          else expanded.add(message.id);
          render();
        },
      }),
      button({
        className: `admin-btn${hidden ? '' : ' is-active'}`,
        text: hidden ? '恢复' : '隐藏',
        title: hidden ? '恢复为可见' : '隐藏（软删除）',
        onClick: () => void toggleStatus(message),
      }),
    );

    li.append(head, el('p', { className: 'gbk__excerpt', text: excerptOf(message) }), ops);
    if (isOpen) li.append(detailNode(message));
    return li;
  }

  function render(): void {
    count.textContent = state.total > 0 ? `共 ${state.total} 条` : '';

    if (state.messages.length === 0) {
      const emptyText = state.q || state.status ? '没有匹配的留言。' : '还没有任何留言。';
      list.replaceChildren(el('li', { className: 'gbk__empty', text: emptyText }));
      moreWrap.hidden = true;
      return;
    }

    list.replaceChildren(...state.messages.map(row));
    moreWrap.hidden = state.cursor === null;
  }

  /* 筛选 ---------------------------------------------------------------- */

  statusSelect.addEventListener('change', () => {
    state.status = statusSelect.value as '' | 'visible' | 'hidden';
    expanded.clear();
    void load();
  });

  search.addEventListener('input', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.q = search.value.trim().slice(0, 80);
      expanded.clear();
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });

  void load(true);

  return {
    element: root,
    dispose: () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      if (statusTimer) window.clearTimeout(statusTimer);
    },
  };
}
