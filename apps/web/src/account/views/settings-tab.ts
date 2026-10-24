/**
 * 「设置」tab：六个分区 + 唯一一份 draft + 吸底保存条。
 *
 * 这一页是整次改造里最容易写坏的地方，所以纪律写在最前面：
 *
 *   1. **骨架与控件只建一次**。切分区只是 `hidden`，不重建 DOM——否则用户切去
 *      「隐私」看一眼再切回「资料」，刚输的半句话就没了。
 *   2. **draft 是唯一真源**。控件只负责把改动写进 draft；渲染方向永远 draft → DOM。
 *      服务端的新数据只有在「本地没有未保存改动」时才允许灌进 draft。
 *   3. **保存用整份 draft 发出去**（不是 diff）。服务端是局部更新语义，多发几个
 *      没改的字段没有副作用；而发 diff 需要自己算差集，容易漏。
 *   4. **离开前拦截**分三条路径：关闭/刷新（beforeunload）、站内跳转（document 捕获）、
 *      分区切换（不丢数据，不拦）。浏览器「后退」拦不住，这一点写在注释里而不是假装解决。
 */

import type { AppRoute } from '../../app-routes';
import { applyUser } from '../../auth/session';
import { SAVE_COPY, SETTINGS_SECTIONS, type SettingsSectionId } from '../../content/account';
import { patchMyProfile, type ProfilePatchInput } from '../api';
import { accButton, accStatus, el } from '../pieces';
import type { MyProfile } from '../types';
import { createAppearancePanel } from './settings/appearance-panel';
import { createBadgesPanel } from './settings/badges-panel';
import { createIdentityPanel } from './settings/identity-panel';
import { createLinksPanel } from './settings/links-panel';
import { createPrivacyPanel } from './settings/privacy-panel';
import { createSecurityPanel } from './settings/security-panel';
import { draftOf, type Draft, type SettingsHub, type SettingsPanel } from './settings/hub';

export interface SettingsTabOptions {
  /** 保存成功 / 媒体更新后通知外面（刷新页头、主页预览、导航栏）。 */
  onData(next: MyProfile): void;
  navigate: (route: AppRoute, param?: string | null) => void;
}

export interface SettingsTabHandle {
  readonly element: HTMLElement;
  apply(data: MyProfile): void;
  dispose(): void;
}

/** 服务端报错时把用户带到对应分区——不然他永远不知道是哪个框红了。 */
const FIELD_SECTION: Record<string, SettingsSectionId> = {
  nickname: 'identity',
  email: 'identity',
  signature: 'identity',
  bio: 'identity',
  gender: 'identity',
  birthday: 'identity',
  region: 'identity',
  currentPassword: 'identity',
  socials: 'links',
  tags: 'badges',
  badges: 'badges',
  theme: 'appearance',
  customCss: 'appearance',
  visibility: 'privacy',
  privacy: 'privacy',
};

export function createSettingsTab(options: SettingsTabOptions): SettingsTabHandle {
  /* -------------------------------------------------------------------------
     状态
  ------------------------------------------------------------------------- */

  let current: MyProfile | null = null;
  let draft: Draft | null = null;
  let savedSnapshot = '';
  let busy = false;

  let section: SettingsSectionId = SETTINGS_SECTIONS[0].id;

  const snapshot = (value: Draft): string => JSON.stringify(value);
  const isDirty = (): boolean => (draft ? snapshot(draft) : '') !== savedSnapshot;

  /* -------------------------------------------------------------------------
     状态行与保存按钮：先建，因为下面 markDirty 要用
  ------------------------------------------------------------------------- */

  const saveStatus = accStatus();
  const saveHint = el('span', { className: 'acc-savebar__hint', text: SAVE_COPY.clean });
  const saveButton = accButton({ label: SAVE_COPY.save, tone: 'primary', icon: 'save' });
  saveButton.disabled = true;

  function markDirty(): void {
    const dirty = isDirty();
    saveButton.disabled = busy || !dirty;
    saveButton.classList.toggle('is-dirty', dirty);
    saveHint.textContent = busy ? SAVE_COPY.saving : dirty ? SAVE_COPY.dirty : SAVE_COPY.clean;
  }

  /* -------------------------------------------------------------------------
     hub（面板只通过它读写）
  ------------------------------------------------------------------------- */

  const hub: SettingsHub = {
    draft(): Draft {
      if (!draft) throw new Error('draft 还没初始化');
      return draft;
    },
    user() {
      if (!current) throw new Error('资料还没加载');
      return current.user;
    },
    meta() {
      return current?.meta ?? { lastLoginAt: null, updatedAt: '' };
    },
    systemBadges() {
      return current?.systemBadges ?? [];
    },
    media() {
      return {
        coverUrl: current?.profile.coverUrl ?? '',
        backgroundUrl: current?.profile.backgroundUrl ?? '',
      };
    },
    patch(partial) {
      if (!draft) return;
      draft = { ...draft, ...partial };
      markDirty();
    },
    status(text, tone) {
      saveStatus.set(text, tone);
    },
    adoptMedia(next) {
      // 媒体变更**不进 draft**（draft 里没有那三个 URL），所以这一步不会把页面弄脏。
      current = next;
      applyUser(next.user);
      options.onData(next);
      syncPanels();
    },
  };

  /* -------------------------------------------------------------------------
     面板
  ------------------------------------------------------------------------- */

  const panels: Record<SettingsSectionId, SettingsPanel> = {
    identity: createIdentityPanel(hub),
    security: createSecurityPanel(hub),
    appearance: createAppearancePanel(hub),
    badges: createBadgesPanel(hub),
    links: createLinksPanel(hub),
    privacy: createPrivacyPanel(hub),
  };

  function syncPanels(): void {
    if (!current) return;
    for (const item of SETTINGS_SECTIONS) panels[item.id].sync(current);
    markDirty();
  }

  /* -------------------------------------------------------------------------
     骨架
  ------------------------------------------------------------------------- */

  const element = el('div', { className: 'acc-panel' });
  element.append(el('p', { className: 'acc-settings__lead', text: '改完记得点下面的保存。' }));

  const subnav = el('nav', { className: 'acc-subnav', attrs: { 'aria-label': '设置分区' } });
  const subButtons = new Map<SettingsSectionId, HTMLButtonElement>();

  function panelOf(id: SettingsSectionId): SettingsPanel {
    return panels[id];
  }

  function show(next: SettingsSectionId): void {
    if (next === section) return;
    panelOf(section).element.hidden = true;
    panelOf(next).element.hidden = false;
    // 切过去时按最新 draft 重画一次：那个面板上次渲染之后 draft 可能已经变了。
    if (current) panelOf(next).sync(current);
    section = next;
    for (const [id, button] of subButtons) {
      button.setAttribute('aria-pressed', String(id === next));
    }
  }

  for (const item of SETTINGS_SECTIONS) {
    const button = el(
      'button',
      {
        className: 'acc-subnav__item',
        attrs: { type: 'button', 'aria-pressed': String(item.id === section) },
      },
      [el('span', { text: item.label })],
    );
    button.addEventListener('click', () => show(item.id));
    subButtons.set(item.id, button);
    subnav.append(button);
  }
  element.append(subnav);

  const stage = el('div', { className: 'acc-panels' });
  for (const item of SETTINGS_SECTIONS) {
    panels[item.id].element.hidden = item.id !== section;
    stage.append(panels[item.id].element);
  }
  element.append(stage);

  const saveBar = el('footer', { className: 'acc-savebar' }, [
    el('div', { className: 'acc-savebar__left' }, [saveHint, saveStatus.element]),
    saveButton,
  ]);
  element.append(saveBar);

  /* -------------------------------------------------------------------------
     保存
  ------------------------------------------------------------------------- */

  const buildPatch = (value: Draft): ProfilePatchInput => {
    const patch: ProfilePatchInput = {
      nickname: value.nickname,
      email: value.email,
      signature: value.signature,
      bio: value.bio,
      gender: value.gender,
      birthday: value.birthday,
      region: value.region,
      socials: value.socials,
      tags: value.tags,
      badges: value.badges,
      theme: value.theme,
      visibility: value.visibility,
      privacy: value.privacy,
      customCss: value.customCss,
    };
    // 乐观锁：别的标签页改过就会 409，而不是把对方的改动悄悄覆盖掉。
    if (current?.meta.updatedAt) patch.expectUpdatedAt = current.meta.updatedAt;
    return patch;
  };

  const save = async (): Promise<void> => {
    if (!draft || !current || busy) return;
    busy = true;
    markDirty();
    saveStatus.set(SAVE_COPY.saving);

    const sent = snapshot(draft);
    const result = await patchMyProfile(buildPatch(draft));
    busy = false;

    if (!result.ok) {
      markDirty();
      const target = result.field ? FIELD_SECTION[result.field] : undefined;
      if (target) show(target);
      saveStatus.set(result.message, 'error');
      return;
    }

    const next = result.data;
    current = next;
    applyUser(next.user);
    options.onData(next);

    // 请求在飞的时候用户又改了东西：保留他的输入，只提示「还没保存」。
    if (draft && snapshot(draft) === sent) {
      draft = draftOf(next);
      savedSnapshot = snapshot(draft);
      syncPanels();
      saveStatus.set(SAVE_COPY.saved, 'ok');
    } else {
      markDirty();
      saveStatus.set('已保存，但你刚才又改了点什么，记得再点一次。', 'ok', 6000);
    }
  };

  saveButton.addEventListener('click', () => {
    void save();
  });

  /* -------------------------------------------------------------------------
     离开前拦截
  ------------------------------------------------------------------------- */

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!isDirty()) return;
    event.preventDefault();
    // 老浏览器只有赋了 returnValue 才会弹确认框。
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  /*
   * 站内跳转：`hashchange` 拦不住——路由会先把视图 unmount 掉。
   * 所以在**捕获阶段**听 document 的 click：本页内部的点击（保存、切分区、上传）
   * 直接放行，只有导航栏 / 账号菜单 / 任意 `#` 链接才问。
   * ⚠️ 浏览器「后退」无法拦截，这是 Web 平台的限制，不假装解决了。
   */
  const onDocumentClick = (event: MouseEvent): void => {
    if (!isDirty()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (element.contains(target)) return;
    const isNavigation =
      target.closest('a[href^="#"]') !== null || target.closest('.site-header') !== null;
    if (!isNavigation) return;
    if (window.confirm(SAVE_COPY.leaveConfirm)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('click', onDocumentClick, true);

  /* -------------------------------------------------------------------------
     对外
  ------------------------------------------------------------------------- */

  return {
    element,
    apply(data: MyProfile): void {
      current = data;
      // 本地有未保存的改动就不覆盖——那是用户正在写的东西。
      if (!draft || !isDirty()) {
        draft = draftOf(data);
        savedSnapshot = snapshot(draft);
      }
      syncPanels();
    },
    dispose(): void {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onDocumentClick, true);
      saveStatus.dispose();
      for (const item of SETTINGS_SECTIONS) panels[item.id].dispose?.();
    },
  };
}
