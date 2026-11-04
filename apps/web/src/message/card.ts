/**
 * 一条留言（含它的回复）。
 *
 * 折迭规则是这块的核心：**默认只露站长的回复，其余的折起来**。留言板是「站长回你一句」
 * 的场景，把十几条路人的寒暄摊在最上面，等于把站长那句话埋了。所以：
 *
 *   · 有站长回复 → 直接显示，带「站长」徽章；
 *   · 有其他人的回复 → 底部一颗「展开 N 条其他回复」；
 *   · 一条都没有 → 整块不渲染（不留空框）。
 *
 * 展开后**整块按时间重排**，而不是把新的追加在后面——否则先显示「站长 10:00」，展开后
 * 下面接一串「09:00、09:30」，时间线就倒着走了。
 */

import { createBlogAvatar } from '../blog/avatar';
import { formatDateTime, formatRelative } from '../blog/present';
import { MESSAGE_COPY } from '../content/message';
import { createMediaImage, enhanceMediaImages, photoLink } from '../shared/media';
import { renderMessageMarkdown } from './markdown';
import type { MessageAuthor, MessageView } from './types';

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

export interface ReplyTarget {
  id: string;
  nickname: string;
  floor: number | null;
}

export interface MessageCardOptions {
  message: MessageView;
  onReply: (target: ReplyTarget) => void;
}

export interface MessageCardHandle {
  element: HTMLLIElement;
  /** 追加一条刚发布的回复（本地插入，不重拉整页）。 */
  appendReply(reply: MessageView): void;
}

/** 时间：显示相对时间，`title` 里给绝对时间（想精确到分钟的人悬停就能看到）。 */
function timeNode(iso: string, className: string): HTMLTimeElement {
  const node = el('time', className, formatRelative(iso));
  node.dateTime = iso;
  node.title = formatDateTime(iso);
  return node;
}

function authorLine(author: MessageAuthor, iso: string, size: 'md' | 'sm'): HTMLElement {
  const line = el('div', size === 'md' ? 'mb-card__byline' : 'mb-reply__byline');
  const avatar = createBlogAvatar(author);
  avatar.classList.add(size === 'md' ? 'mb-card__avatar' : 'mb-reply__avatar');
  line.append(avatar, el('span', size === 'md' ? 'mb-card__name' : 'mb-reply__name', author.nickname));
  if (author.owner) line.append(el('span', 'mb-badge mb-badge--owner', MESSAGE_COPY.ownerBadge));
  if (author.deleted) line.append(el('span', 'mb-badge mb-badge--muted', '账号已注销'));
  line.append(timeNode(iso, size === 'md' ? 'mb-card__time' : 'mb-reply__time'));
  return line;
}

/** 图片网格。点击进站内原图页（原来的灯箱已删除，见 `pages/message.ts` 顶部注释）。 */
function imageGrid(urls: string[]): HTMLElement | null {
  if (urls.length === 0) return null;
  const grid = el('div', 'mb-shots');
  for (const url of urls) {
    // 格子 7rem 见方，`thumb` 那档（512）够用。`.mb-shot` 自带 `cursor: zoom-in`
    // 与 `display: block`，对 `<a>` 一样生效，不用改样式。
    const img = createMediaImage({ src: url, tier: 'thumb', className: 'mb-shot__img' });
    const shot = photoLink(url, img, 'mb-shot');
    shot.setAttribute('aria-label', '查看原图');
    grid.append(shot);
  }
  return grid;
}

/** 正文：简单模式是纯文本（`pre-wrap` 保住换行），Markdown 模式走白名单渲染。 */
function bodyNode(message: MessageView, className: string): HTMLElement {
  if (message.mode === 'markdown') {
    const box = el('div', `${className} md-body`);
    box.append(renderMessageMarkdown(message.body));
    // 正文里的站内插图同样走压缩版 + 原图页（高度可能比网格里那张大得多）。
    enhanceMediaImages(box, 'content');
    return box;
  }
  return el('div', className, message.body);
}

function replyNode(reply: MessageView): HTMLElement {
  const hidden = reply.status !== 'visible';
  const node = el('div', `mb-reply${reply.author.owner ? ' is-owner' : ''}${hidden ? ' is-deleted' : ''}`);
  node.append(authorLine(reply.author, reply.createdAt, 'sm'));

  if (hidden) {
    node.append(el('p', 'mb-reply__body is-deleted', MESSAGE_COPY.deleted));
    return node;
  }

  const grid = imageGrid(reply.images);
  if (grid) node.append(grid);
  if (reply.body) node.append(bodyNode(reply, 'mb-reply__body'));
  return node;
}

export function createMessageCard(options: MessageCardOptions): MessageCardHandle {
  const message = options.message;
  const replies = [...message.replies];
  let expanded = false;

  const li = el('li', `mb-card${message.author.owner ? ' is-owner' : ''}`);
  li.dataset.messageId = message.id;

  /* 头部 ---------------------------------------------------------------- */
  const head = el('header', 'mb-card__head');
  head.append(authorLine(message.author, message.createdAt, 'md'));

  if (message.mode === 'markdown') {
    head.append(el('span', 'mb-badge', MESSAGE_COPY.markdownBadge));
  }
  if (message.floor !== null) {
    head.append(el('span', 'mb-card__floor', `#${message.floor}`));
  }
  li.append(head);

  /* 正文（图片在文字前面，这是留言板的固定顺序） ---------------------------- */
  const grid = imageGrid(message.images);
  if (grid) li.append(grid);
  if (message.body) li.append(bodyNode(message, 'mb-card__body'));

  /* 操作条 -------------------------------------------------------------- */
  const ops = el('footer', 'mb-card__ops');
  const replyButton = el('button', 'mb-reply-btn', MESSAGE_COPY.replyAction);
  replyButton.type = 'button';
  replyButton.addEventListener('click', () =>
    options.onReply({ id: message.id, nickname: message.author.nickname, floor: message.floor }),
  );
  ops.append(replyButton);
  li.append(ops);

  /* 回复区 -------------------------------------------------------------- */
  const repliesBox = el('div', 'mb-replies');
  li.append(repliesBox);

  function paintReplies(): void {
    repliesBox.replaceChildren();
    if (replies.length === 0) {
      repliesBox.hidden = true;
      return;
    }
    repliesBox.hidden = false;

    const owners = replies.filter((reply) => reply.author.owner);
    const others = replies.filter((reply) => !reply.author.owner);
    const showAll = expanded || others.length === 0;
    const list = showAll ? replies : owners;

    for (const reply of list) repliesBox.append(replyNode(reply));

    if (others.length > 0) {
      const toggle = el('button', 'mb-replies__toggle');
      toggle.type = 'button';
      toggle.textContent = expanded
        ? MESSAGE_COPY.collapseReplies
        : `${MESSAGE_COPY.expandReplies} ${others.length} ${
            owners.length > 0 ? MESSAGE_COPY.replyUnitOther : MESSAGE_COPY.replyUnit
          }`;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        paintReplies();
      });
      repliesBox.append(toggle);
    }
  }

  paintReplies();

  return {
    element: li,
    appendReply(reply) {
      replies.push(reply);
      // 自己刚发的那条一定要看得见：站长的回复本来就露着，普通人的要展开一次。
      expanded = true;
      paintReplies();
    },
  };
}
