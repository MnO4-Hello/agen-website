/**
 * 一个楼层。
 *
 * 楼层号 `#n` 是**服务端分配的、永不回收的**（见 `apps/api/src/blog/store.ts`），
 * 所以这里只管渲染，不做任何「第几条」的推算——本地算一次就会和软删除后的实际情况错开。
 *
 * 被隐藏的楼层仍然占位：正文换成一句「该回复已删除」，楼层号与引用链保持完整。
 * 这比「整条消失」重要得多——否则第 3 楼引用的 `#2` 会突然指向别人。
 */

import { createBlogAvatar } from './avatar';
import { formatRelative, floorLabel } from './present';
import type { ReplyView, VoteResult, VoteValue } from './types';
import { createVoteBar, type VoteBarHandle } from './vote';

export interface FloorOptions {
  reply: ReplyView;
  onReply: (floor: number, nickname: string) => void;
  onVote: (reply: ReplyView, next: VoteValue) => void;
}

export interface FloorHandle {
  element: HTMLElement;
  setVote(result: VoteResult): void;
}

export function createFloor(options: FloorOptions): FloorHandle {
  const { reply } = options;
  const hidden = reply.status !== 'visible' || !reply.body;

  const item = document.createElement('li');
  item.className = 'bp-floor';
  item.id = `floor-${reply.floor}`;
  item.dataset.floor = String(reply.floor);

  const side = document.createElement('div');
  side.className = 'bp-floor__side';
  side.append(createBlogAvatar(reply.author));

  const main = document.createElement('div');
  main.className = 'bp-floor__main';

  const head = document.createElement('div');
  head.className = 'bp-floor__head';

  const name = document.createElement('span');
  name.className = 'bp-floor__name';
  name.textContent = reply.author.nickname;
  head.append(name);

  if (reply.author.owner) {
    const badge = document.createElement('span');
    badge.className = 'bp-badge bp-badge--owner';
    badge.textContent = '站长';
    head.append(badge);
  }
  if (reply.author.deleted) {
    const badge = document.createElement('span');
    badge.className = 'bp-badge';
    badge.textContent = '已注销';
    head.append(badge);
  }

  const floor = document.createElement('span');
  floor.className = 'bp-floor__no';
  floor.textContent = floorLabel(reply.floor);
  head.append(floor);

  const time = document.createElement('time');
  time.className = 'bp-floor__time';
  time.dateTime = reply.createdAt;
  time.textContent = formatRelative(reply.createdAt);
  head.append(time);

  main.append(head);

  if (reply.replyToFloor !== null) {
    const quote = document.createElement('p');
    quote.className = 'bp-floor__quote';
    quote.textContent = `回复 ${reply.replyToName} ${floorLabel(reply.replyToFloor)}`;
    main.append(quote);
  }

  const body = document.createElement('p');
  body.className = 'bp-floor__body';
  if (hidden) {
    body.classList.add('is-deleted');
    body.textContent = '该回复已删除';
  } else {
    // 纯文本 + CSS `white-space: pre-wrap`：保留换行，但没有任何标签解析入口。
    body.textContent = reply.body;
  }
  main.append(body);

  let votes: VoteBarHandle | null = null;
  if (!hidden) {
    const ops = document.createElement('div');
    ops.className = 'bp-floor__ops';

    votes = createVoteBar({
      up: reply.up,
      down: reply.down,
      value: reply.myVote,
      variant: 'inline',
      onVote: (next) => options.onVote(reply, next),
    });
    ops.append(votes.element);

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'bp-floor__reply';
    replyButton.textContent = '回复';
    replyButton.addEventListener('click', () => options.onReply(reply.floor, reply.author.nickname));
    ops.append(replyButton);

    main.append(ops);
  }

  item.append(side, main);

  return {
    element: item,
    setVote(result) {
      votes?.setResult(result);
    },
  };
}
