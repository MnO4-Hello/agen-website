/**
 * 设置 · 社交链接
 *
 * 行是可以增删的，所以这里没有「一个固定输入框」，而是每次改动都重画整张列表。
 * 重画会丢焦点——所以 `input` 事件只改 draft、**不重画**；只有增删行才重画。
 */

import { LINKS_COPY } from '../../../content/account';
import { accBlock, accButton, accIconButton, accInput, accStatus, el } from '../../pieces';
import { LIMITS, type MyProfile, type SocialLink } from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

function newLinkId(): string {
  return `s-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

export function createLinksPanel(hub: SettingsHub): SettingsPanel {
  const status = accStatus();
  const list = el('div', { className: 'acc-links' });

  const paint = (): void => {
    const links = hub.draft().socials;
    if (links.length === 0) {
      list.replaceChildren(el('p', { className: 'acc-muted', text: LINKS_COPY.empty }));
      return;
    }

    const rows = links.map((link, index) => {
      const label = accInput({
        value: link.label,
        placeholder: LINKS_COPY.labelPlaceholder,
        onInput: (value) => update(index, { label: value }),
      });
      label.setAttribute('aria-label', LINKS_COPY.label);

      const url = accInput({
        value: link.url,
        placeholder: LINKS_COPY.urlPlaceholder,
        inputMode: 'text',
        onInput: (value) => update(index, { url: value }),
      });
      url.setAttribute('aria-label', LINKS_COPY.url);

      return el('div', { className: 'acc-links__row' }, [
        label,
        url,
        accIconButton('close', `删除链接 ${link.label || index + 1}`, () => {
          hub.patch({ socials: hub.draft().socials.filter((_, i) => i !== index) });
          paint();
        }),
      ]);
    });

    list.replaceChildren(...rows);
  };

  /** 只改 draft，不重画——否则每敲一个字焦点就掉一次。 */
  const update = (index: number, patch: Partial<SocialLink>): void => {
    const next = hub.draft().socials.map((link, i) => (i === index ? { ...link, ...patch } : link));
    hub.patch({ socials: next });
  };

  const add = accButton({
    label: LINKS_COPY.add,
    icon: 'plus',
    onClick: () => {
      const current = hub.draft().socials;
      if (current.length >= LIMITS.linkCount) {
        status.set(`最多 ${LIMITS.linkCount} 条链接。`, 'error');
        return;
      }
      hub.patch({ socials: [...current, { id: newLinkId(), label: '', url: '' }] });
      paint();
      status.clear();
    },
  });

  // 用 `accBlock` 而不是裸容器：其余五个分区都是「标题 + 说明 + 内容」的卡片，
  // 这里少一层会显得像是没加载出来（第一版就是裸 div，截图里一眼就看出不一致）。
  const block = accBlock({ title: LINKS_COPY.title, note: LINKS_COPY.note });
  block.body.append(list, el('div', { className: 'acc-media__actions' }, [add]), status.element);
  const element = block.element;

  return {
    element,
    sync(_data: MyProfile): void {
      paint();
    },
  };
}
