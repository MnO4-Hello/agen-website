/**
 * 后台「回复」面板：按帖子看全部楼层，可以对单条做隐藏 / 恢复。
 *
 * **没有「删除」**：楼层号是引用的锚点（`#3`），硬删会让同一帖里所有引用集体错位且
 * 无法修复。隐藏 = 软删除，前台显示「该回复已删除」，楼层号与引用链保持完整。
 *
 * 后台能看到被隐藏楼层的**正文**（`pickReply(..., keepHiddenBody=true)`）——否则「复核」
 * 无从下手：只看得到一个「已删除」的占位块，没法判断该不该恢复。
 */

import type { AdminPost, AdminReply } from '../api';
import { button, el, formatDateTime } from '../ui';
import type { PostsSource } from './post-source';

export interface ReplyPanelOptions {
  source: PostsSource;
  post: AdminPost;
  onBack: () => void;
  setStatus: (text: string, tone?: 'info' | 'ok' | 'error') => void;
}

export interface ReplyPanelHandle {
  element: HTMLElement;
  dispose(): void;
}

const PREVIEW_LENGTH = 90;

export function createReplyPanel(options: ReplyPanelOptions): ReplyPanelHandle {
  let closed = false;
  let busy = false;
  let cursor: string | null = null;
  const replies: AdminReply[] = [];

  const root = el('div', { className: 'bps-replies' });

  const head = el('div', { className: 'bps-replies__head' });
  const back = button({
    className: 'admin-btn admin-btn--ghost',
    text: '返回列表',
    onClick: options.onBack,
  });
  const title = el('div', { className: 'bps-replies__title' });
  title.append(
    el('span', { className: 'bps-replies__post', text: `《${options.post.title}》` }),
    el('span', { className: 'bps-replies__count', text: `${options.post.replyCount} 条回复` }),
  );
  head.append(back, title);

  const hint = el('p', {
    className: 'bps-replies__hint',
    text: '「隐藏」是软删除：楼层号保留，前台显示「该回复已删除」，引用它的楼不会错位。',
  });

  const list = el('ul', { className: 'bps-replies__list' });

  const moreWrap = el('div', { className: 'bps-replies__more' });
  const moreButton = button({
    className: 'admin-btn',
    text: '加载更多',
    onClick: () => void loadMore(),
  });
  moreWrap.append(moreButton);

  root.append(head, hint, list, moreWrap);

  async function toggle(reply: AdminReply): Promise<void> {
    if (busy) return;
    busy = true;
    const next = reply.status === 'visible' ? 'hidden' : 'visible';
    const result = await options.source.setReplyStatus(reply.id, next);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      return;
    }
    reply.status = result.data.reply.status;
    options.setStatus(next === 'hidden' ? '已隐藏这一楼。' : '已恢复这一楼。', 'ok');
    render();
  }

  function render(): void {
    if (replies.length === 0) {
      list.replaceChildren(el('li', { className: 'bps-replies__empty', text: '这篇帖子还没有回复。' }));
      moreWrap.hidden = true;
      return;
    }

    list.replaceChildren(
      ...replies.map((reply) => {
        const hidden = reply.status !== 'visible';
        const row = el('li', { className: `bps-replies__row${hidden ? ' is-hidden' : ''}` });

        const meta = el('div', { className: 'bps-replies__meta' });
        meta.append(el('span', { className: 'bps-replies__floor', text: `#${reply.floor}` }));

        const name = el('span', {
          className: `bps-replies__name${reply.author.kind === 'guest' ? ' is-guest' : ''}`,
          text: reply.author.nickname,
        });
        meta.append(name);

        if (reply.author.owner) {
          meta.append(el('span', { className: 'admin-pill', text: '站长' }));
        }
        if (hidden) meta.append(el('span', { className: 'admin-pill is-danger', text: '已隐藏' }));
        if (reply.replyToFloor !== null) {
          meta.append(
            el('span', {
              className: 'bps-replies__quote',
              text: `回复 ${reply.replyToName} #${reply.replyToFloor}`,
            }),
          );
        }
        meta.append(
          el('span', { className: 'bps-replies__time', text: formatDateTime(Date.parse(reply.createdAt)) }),
        );

        const body = el('p', {
          className: 'bps-replies__body',
          text:
            reply.body.length > PREVIEW_LENGTH
              ? `${reply.body.slice(0, PREVIEW_LENGTH)}…`
              : reply.body,
        });

        const ops = el('div', { className: 'bps-replies__ops' });
        ops.append(
          button({
            className: `admin-btn${hidden ? '' : ' is-active'}`,
            text: hidden ? '恢复' : '隐藏',
            title: hidden ? '恢复为可见' : '隐藏（软删除，保留楼层号）',
            onClick: () => void toggle(reply),
          }),
        );

        row.append(meta, body, ops);
        return row;
      }),
    );

    moreWrap.hidden = cursor === null;
    moreButton.disabled = cursor === null;
  }

  async function loadMore(): Promise<void> {
    moreButton.disabled = true;
    moreButton.textContent = '正在加载…';
    const result = await options.source.replies(options.post.id, cursor ?? '');
    if (closed) return;
    moreButton.textContent = '加载更多';
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      moreButton.disabled = false;
      return;
    }
    const known = new Set(replies.map((reply) => reply.id));
    for (const reply of result.data.replies) {
      if (!known.has(reply.id)) replies.push(reply);
    }
    cursor = result.data.nextCursor;
    render();
  }

  void loadMore();

  return {
    element: root,
    dispose: () => {
      closed = true;
    },
  };
}
