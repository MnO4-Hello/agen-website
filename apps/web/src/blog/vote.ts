/**
 * 赞同 / 反对控件。
 *
 * 一个纯展示 + 抛事件的组件：**它自己不发请求、也不判断登录**。为什么这么切：
 * 帖子在详情页、回复在楼层里，两处的"未登录怎么办"完全一样（记下返回位置、跳登录），
 * 但"请求成功怎么更新数字"一个改页面、一个只改自己那一格。把请求留给调用方，
 * 两处都能按自己的粒度更新，而样式只有这一份。
 *
 * 点击语义与知乎一致：点到已选中的方向 = 撤销（`0`）。
 */

import type { VoteResult, VoteValue } from './types';

export interface VoteBarState {
  up: number;
  down: number;
  value: VoteValue;
}

export interface VoteBarOptions extends VoteBarState {
  /** `rail` = 详情页左侧竖排大按钮；`inline` = 楼层里的小号横排。 */
  variant?: 'rail' | 'inline';
  onVote: (next: VoteValue) => void;
}

export interface VoteBarHandle {
  element: HTMLElement;
  set(state: VoteBarState): void;
  setResult(result: VoteResult): void;
  setBusy(busy: boolean): void;
}

export function createVoteBar(options: VoteBarOptions): VoteBarHandle {
  const variant = options.variant ?? 'inline';
  let state: VoteBarState = { up: options.up, down: options.down, value: options.value };

  const root = document.createElement('div');
  root.className = `bl-vote bl-vote--${variant}`;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '赞同或反对');

  const makeButton = (direction: 1 | -1): { button: HTMLButtonElement; count: HTMLElement } => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bl-vote__btn bl-vote__btn--${direction === 1 ? 'up' : 'down'}`;
    button.title = direction === 1 ? '赞同' : '反对';

    const glyph = document.createElement('span');
    glyph.className = 'bl-vote__glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = direction === 1 ? '▲' : '▼';

    const count = document.createElement('span');
    count.className = 'bl-vote__count';

    const label = document.createElement('span');
    label.className = 'bl-sr-only';
    label.textContent = direction === 1 ? '赞同' : '反对';

    button.append(glyph, count, label);
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const next: VoteValue = state.value === direction ? 0 : direction;
      options.onVote(next);
    });

    return { button, count };
  };

  const up = makeButton(1);
  const down = makeButton(-1);
  root.append(up.button, down.button);

  const paint = (): void => {
    up.count.textContent = String(state.up);
    down.count.textContent = String(state.down);
    up.button.setAttribute('aria-pressed', state.value === 1 ? 'true' : 'false');
    down.button.setAttribute('aria-pressed', state.value === -1 ? 'true' : 'false');
    up.button.classList.toggle('is-active', state.value === 1);
    down.button.classList.toggle('is-active', state.value === -1);
    // 反对数为 0 时把数字藏起来：一排「▲ 0 ▼ 0」比只显示一个「▲ 0」脏得多。
    down.count.hidden = state.down === 0 && state.value !== -1;
  };

  paint();

  return {
    element: root,
    set(next) {
      state = { ...next };
      paint();
    },
    setResult(result) {
      state = { up: result.up, down: result.down, value: result.myVote };
      paint();
    },
    setBusy(busy) {
      up.button.disabled = busy;
      down.button.disabled = busy;
      root.classList.toggle('is-busy', busy);
    },
  };
}
