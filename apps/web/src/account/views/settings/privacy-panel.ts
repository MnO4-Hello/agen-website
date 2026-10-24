/**
 * 设置 · 隐私
 *
 * 两件事：**主页整体对谁可见**（游客开关），以及**每个字段单独三档**。
 *
 * 必显项（昵称 / 头像 / 用户名）不给控件，只给一句说明——给一个禁用的开关比不给
 * 更容易让人以为「点了没反应」，还不如说清楚为什么不能改。
 */

import {
  PRIVACY_COPY,
  PRIVACY_LEVEL_LABEL,
  PRIVACY_LEVEL_NOTE,
  PRIVACY_ORDER,
  VISIBILITY_OPTIONS,
} from '../../../content/account';
import { accBlock, accSegmented, accStatus, el } from '../../pieces';
import type { MyProfile, PrivacyLevel, ProfileField, ProfileVisibility } from '../../types';
import type { SettingsHub, SettingsPanel } from './hub';

const LEVELS: readonly { value: PrivacyLevel; label: string; note: string }[] = (
  ['public', 'self', 'hidden'] as const
).map((value) => ({
  value,
  label: PRIVACY_LEVEL_LABEL[value],
  note: PRIVACY_LEVEL_NOTE[value],
}));

const FIELD_LABEL: Record<ProfileField, string> = {
  signature: PRIVACY_COPY.signature,
  bio: PRIVACY_COPY.bio,
  gender: PRIVACY_COPY.gender,
  birthday: PRIVACY_COPY.birthday,
  region: PRIVACY_COPY.region,
  socials: PRIVACY_COPY.socials,
  tags: PRIVACY_COPY.tags,
  badges: PRIVACY_COPY.badges,
  lastLogin: PRIVACY_COPY.lastLogin,
};

export function createPrivacyPanel(hub: SettingsHub): SettingsPanel {
  const status = accStatus();

  /* -------------------------------------------------------------------------
     游客开关
  ------------------------------------------------------------------------- */

  const visibility = accSegmented<ProfileVisibility>({
    options: VISIBILITY_OPTIONS.map((item) => ({
      value: item.value,
      label: item.label,
      note: item.note,
    })),
    value: 'public',
    onChange: (next) => {
      hub.patch({ visibility: next });
      status.set('改好了，记得保存。', 'ok');
    },
  });

  const visibilityBlock = accBlock({
    title: PRIVACY_COPY.visibilityTitle,
    note: '这就是「游客开关」——它决定没登录的人能不能打开你的主页。',
  });
  visibilityBlock.body.append(visibility.element);

  /* -------------------------------------------------------------------------
     必显项
  ------------------------------------------------------------------------- */

  const requiredBlock = accBlock({
    title: PRIVACY_COPY.requiredTitle,
    note: PRIVACY_COPY.requiredNote,
  });
  requiredBlock.body.append(
    el('div', { className: 'acc-privacy__required' }, [
      el('span', { className: 'acc-pill', text: '昵称' }),
      el('span', { className: 'acc-pill', text: '头像' }),
      el('span', { className: 'acc-pill', text: '用户名' }),
      el('span', { className: 'acc-pill acc-pill--locked', text: '不可隐藏' }),
    ]),
  );

  /* -------------------------------------------------------------------------
     逐字段三档
  ------------------------------------------------------------------------- */

  const fieldRows = new Map<
    ProfileField,
    { row: HTMLElement; set(value: PrivacyLevel): void }
  >();

  const fieldsBlock = accBlock({ title: '逐项决定', note: PRIVACY_COPY.note });

  for (const field of PRIVACY_ORDER) {
    const segmented = accSegmented<PrivacyLevel>({
      options: LEVELS,
      value: 'public',
      compact: true,
      onChange: (next) => {
        hub.patch({ privacy: { ...hub.draft().privacy, [field]: next } });
      },
    });
    const row = el('div', { className: 'acc-privacy__row' }, [
      el('span', { className: 'acc-privacy__label', text: FIELD_LABEL[field] }),
      segmented.element,
    ]);
    fieldRows.set(field, { row, set: segmented.set });
    fieldsBlock.body.append(row);
  }

  fieldsBlock.body.append(status.element);

  const element = el('div', {}, [
    visibilityBlock.element,
    requiredBlock.element,
    fieldsBlock.element,
  ]);

  return {
    element,
    sync(_data: MyProfile): void {
      const draft = hub.draft();
      visibility.set(draft.visibility);
      for (const [field, handle] of fieldRows) {
        handle.set(draft.privacy[field]);
      }
    },
  };
}
