/**
 * 设置 · 徽章与标签
 *
 * 两条通道严格分开：
 *
 *   · **系统徽章**只读，由服务端算（角色 / 注册年份 / 早期用户）；
 *   · **自建徽章**可编辑，但是白名单式校验——名字不能撞「官方 / 认证 / 站长」这类
 *     保留词，也不能和系统徽章重名，还不能以对勾/盾牌开头。
 *
 * 前端先拦一遍是为了即时反馈，**服务端才是权威**（同一个名字在那里还会再查一次）。
 */

import { BADGES_COPY } from '../../../content/account';
import {
  accBlock,
  accButton,
  accField,
  accInput,
  accStatus,
  customBadgeChip,
  el,
  systemBadgeChip,
  tagChip,
} from '../../pieces';
import { LIMITS, type CustomBadge, type MyProfile } from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

/** 与服务端 `BADGE_RESERVED` 同源；只用于即时提示。 */
const RESERVED = new Set([
  '官方',
  '认证',
  '已认证',
  '官方认证',
  '站长',
  '管理员',
  '系统',
  '客服',
  '版主',
  '审核',
  'official',
  'verified',
  'admin',
  'owner',
  'system',
  'staff',
  'moderator',
  'support',
]);

const RESERVED_PREFIX = /^[✔✓✅☑🛡🔰⭐★]/;

function badgeKey(label: string): string {
  return label.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function createBadgesPanel(hub: SettingsHub): SettingsPanel {
  const status = accStatus();

  /* -------------------------------------------------------------------------
     系统徽章（只读）
  ------------------------------------------------------------------------- */

  const systemRow = el('div', { className: 'acc-badges' });
  const systemBlock = accBlock({
    title: BADGES_COPY.systemTitle,
    note: BADGES_COPY.systemNote,
  });
  systemBlock.body.append(systemRow);

  /* -------------------------------------------------------------------------
     标签
  ------------------------------------------------------------------------- */

  const tagRow = el('div', { className: 'acc-badges' });
  const tagInput = accInput({
    value: '',
    placeholder: BADGES_COPY.tagPlaceholder,
  });
  const tagCounter = el('span', { className: 'acc-field__count' });

  const commitTag = (): void => {
    const value = tagInput.value.trim();
    if (!value) return;
    const current = hub.draft().tags;
    if (current.length >= LIMITS.tagCount) {
      status.set(`标签最多 ${LIMITS.tagCount} 个。`, 'error');
      return;
    }
    if (Array.from(value).length > LIMITS.tagLength) {
      status.set(`单个标签最多 ${LIMITS.tagLength} 个字。`, 'error');
      return;
    }
    if (current.includes(value)) {
      status.set('这个标签已经有了。', 'error');
      return;
    }
    hub.patch({ tags: [...current, value] });
    tagInput.value = '';
    paintTags(hub.draft().tags);
    status.clear();
  };

  tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTag();
    }
  });

  const tagField = accField({
    label: '标签',
    control: tagInput,
    hint: BADGES_COPY.tagsHint,
  });
  tagField.element.querySelector('.acc-field__head')?.append(tagCounter);

  const tagsBlock = accBlock({ title: BADGES_COPY.tagsTitle, note: BADGES_COPY.tagsHint });
  tagsBlock.body.append(tagField.element, tagRow);

  const paintTags = (tags: string[]): void => {
    tagRow.replaceChildren(
      ...(tags.length > 0
        ? tags.map((tag) =>
            tagChip(tag, () => {
              hub.patch({ tags: hub.draft().tags.filter((item) => item !== tag) });
              paintTags(hub.draft().tags);
            }),
          )
        : [el('span', { className: 'acc-muted', text: '还没有标签。' })]),
    );
    tagCounter.textContent = `${tags.length} / ${LIMITS.tagCount}`;
  };

  /* -------------------------------------------------------------------------
     自建徽章
  ------------------------------------------------------------------------- */

  const badgeRow = el('div', { className: 'acc-badges' });

  const emojiInput = accInput({ value: '', placeholder: '🎨' });
  emojiInput.classList.add('acc-input--emoji');
  emojiInput.setAttribute('aria-label', BADGES_COPY.badgeEmoji);

  const nameInput = accInput({ value: '', placeholder: '画画的人' });
  nameInput.setAttribute('aria-label', BADGES_COPY.badgeName);

  const colorInput = el('input', {
    className: 'acc-color__picker',
    attrs: { type: 'color', value: '#3f7d58', 'aria-label': BADGES_COPY.badgeColor },
  });

  const addBadge = accButton({
    label: BADGES_COPY.badgeAdd,
    icon: 'plus',
    onClick: () => {
      const label = nameInput.value.trim();
      const key = badgeKey(label);
      if (!label) {
        status.set('徽章得有个名字。', 'error');
        nameInput.focus();
        return;
      }
      if (Array.from(label).length > LIMITS.badgeLabel) {
        status.set(`徽章名最多 ${LIMITS.badgeLabel} 个字。`, 'error');
        return;
      }
      if (RESERVED.has(key)) {
        status.set(`「${label}」是保留名称，换一个吧。`, 'error');
        return;
      }
      if (RESERVED_PREFIX.test(label)) {
        status.set('徽章名不能以对勾或盾牌开头——那是系统徽章的样子。', 'error');
        return;
      }
      const current = hub.draft().badges;
      if (current.length >= LIMITS.badgeCount) {
        status.set(`最多 ${LIMITS.badgeCount} 枚徽章。`, 'error');
        return;
      }
      const taken = new Set([
        ...current.map((badge) => badgeKey(badge.label)),
        ...hub.systemBadges().map((badge) => badgeKey(badge.label)),
      ]);
      if (taken.has(key)) {
        status.set('已经有同名的徽章了。', 'error');
        return;
      }

      const badge: CustomBadge = {
        // id 只在本地当 key 用；服务端会重新生成自己的（不信客户端传的 id）。
        id: `b-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`,
        label,
        color: colorInput.value.toLowerCase(),
        emoji: emojiInput.value.trim(),
      };
      hub.patch({ badges: [...current, badge] });
      paintBadges(hub.draft().badges);
      nameInput.value = '';
      emojiInput.value = '';
      status.set('加好了，记得保存。', 'ok');
    },
  });

  const creator = el('div', { className: 'acc-badgecreator' }, [
    el('div', { className: 'acc-badgecreator__fields' }, [emojiInput, nameInput, colorInput]),
    addBadge,
  ]);

  const badgesBlock = accBlock({ title: BADGES_COPY.customTitle, note: BADGES_COPY.customNote });
  badgesBlock.body.append(badgeRow, creator, status.element);

  const paintBadges = (badges: CustomBadge[]): void => {
    badgeRow.replaceChildren(
      ...(badges.length > 0
        ? badges.map((badge) =>
            customBadgeChip(badge, () => {
              hub.patch({ badges: hub.draft().badges.filter((item) => item.id !== badge.id) });
              paintBadges(hub.draft().badges);
            }),
          )
        : [el('span', { className: 'acc-muted', text: '还没有自建徽章。' })]),
    );
  };

  const element = el('div', {}, [systemBlock.element, badgesBlock.element, tagsBlock.element]);

  return {
    element,
    sync(data: MyProfile): void {
      systemRow.replaceChildren(
        ...(data.systemBadges.length > 0
          ? data.systemBadges.map((badge) => systemBadgeChip(badge))
          : [el('span', { className: 'acc-muted', text: '暂时没有。' })]),
      );
      paintTags(hub.draft().tags);
      paintBadges(hub.draft().badges);
    },
  };
}
