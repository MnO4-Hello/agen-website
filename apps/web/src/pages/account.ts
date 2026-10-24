/**
 * 个人中心 / 我的主页 / 设置（`#account/<tab>`）。
 *
 * 这一版把原来的占位页换成了真实的三块内容，并且改了**切 tab 的方式**：
 *
 *   `#account/profile → #account/settings` 以前走的是完整路由（`router.navigate`），
 *   也就是把整个视图 dispose 掉再新建。设置页有一堆输入框，那样切一次 tab 就全丢。
 *   现在三个面板**同时存在于 DOM**，切换只改 `hidden`，地址栏用 `history.replaceState`
 *   同步——刷新与分享仍然落回同一个 tab，但不触发 `hashchange`、不重建视图。
 *
 * 与 `pages/auth.ts` 的纪律完全一致（那边是登录/注册两个表单同时存在只切 hidden）。
 *
 * 另外一条：`subscribe()` 的回调**只允许 patch**，不许 `replaceChildren`。它会因为
 * 「保存资料」「换头像」「切回前台重新核对会话」等各种原因被调用，整块重建就会把
 * 用户正在输入的内容冲掉。
 */

import type { AppRoute } from '../app-routes';
import { getAuthState, rememberReturnTo, subscribe, type AuthState } from '../auth/session';
import { createAvatar } from '../components/avatar';
import { ACCOUNT_EMPTY_COPY } from '../content/account';
import { ACCOUNT_GUEST_COPY, ACCOUNT_TABS, ROLE_LABEL } from '../content/auth';
import type { RouteView } from '../router';
import { ACCOUNT_UNAUTHORIZED, fetchMyProfile, profileHref } from '../account/api';
import { accButton, el } from '../account/pieces';
import type { MyProfile } from '../account/types';
import { createHomeTab, type HomeTabHandle } from '../account/views/home-tab';
import { createProfileTab, type ProfileTabHandle } from '../account/views/profile-tab';
import { createSettingsTab, type SettingsTabHandle } from '../account/views/settings-tab';

export type AccountTab = 'profile' | 'home' | 'settings';

/** 非法 tab 一律落到「个人中心」；不纠正地址栏（`matchRoute` 已经把参数规范过了）。 */
export function parseAccountTab(param: string | null): AccountTab {
  return param === 'home' || param === 'settings' ? param : 'profile';
}

export interface AccountPageOptions {
  readonly tab: AccountTab;
  readonly navigate: (route: AppRoute, param?: string | null) => void;
}

type PanelId = AccountTab;

interface HeadHandle {
  readonly element: HTMLElement;
  applyUser(data: MyProfile | null, state: AuthState): void;
  dispose(): void;
}

function createHead(): HeadHandle {
  const avatarHost = el('span', { className: 'account-page__avatar' });
  const name = el('h1', { className: 'account-page__name' });
  const handle = el('span', { className: 'account-page__handle' });
  const role = el('span', { className: 'account-page__role' });
  const signature = el('p', { className: 'account-page__signature' });
  signature.hidden = true;

  const meta = el('p', { className: 'account-page__meta' }, [handle, role]);
  const identity = el('div', { className: 'account-page__identity' }, [name, meta, signature]);

  /*
   * 「查看公开主页」用 `<a href="#u/…">` 而不是 `router.navigate`：
   * 中键开新标签、右键复制链接这些浏览器原生行为都能用，路由那边本来就监听 hashchange。
   * `hidden` 兜底：无账号态时整块 head 都藏起来了，这里不用再单独判断。
   */
  const publicLink = el('a', {
    className: 'acc-btn acc-btn--ghost',
    text: ACCOUNT_EMPTY_COPY.publicAction,
    attrs: { href: '#u/' },
  });
  const actions = el('div', { className: 'account-page__actions' }, [publicLink]);
  const element = el('header', { className: 'account-page__head' }, [avatarHost, identity, actions]);

  return {
    element,
    applyUser(data, state): void {
      if (state.status !== 'user') {
        element.hidden = true;
        return;
      }
      element.hidden = false;

      const user = state.user;
      name.textContent = user.nickname;
      handle.textContent = `@${user.username}`;
      role.textContent = ROLE_LABEL[user.role];
      publicLink.href = profileHref(user.username);

      // 头像是**换节点**而不是改属性：`createAvatar` 每次返回新元素，直接替换最省事，
      // 也顺带把「上传失败回退首字」的逻辑一起拿到。
      avatarHost.replaceChildren(
        createAvatar({ nickname: user.nickname, avatarUrl: user.avatarUrl, size: 'lg' }),
      );

      const text = data?.profile.signature ?? '';
      signature.textContent = text;
      signature.hidden = !text;
    },
    dispose(): void {
      avatarHost.replaceChildren();
    },
  };
}

export function createAccountPage(options: AccountPageOptions): RouteView {
  const section = el('section', { className: 'account-page' });
  const inner = el('div', { className: 'account-page__inner' });
  section.append(inner);

  let data: MyProfile | null = null;
  let loading = false;
  let tab: PanelId = options.tab;

  /* -------------------------------------------------------------------------
     客态 / 加载 / 出错：三张卡片共用同一块位置
  ------------------------------------------------------------------------- */

  const elsewhere = el('div', { className: 'acc-elsewhere' });
  const elsewhereTitle = el('h1', { className: 'acc-elsewhere__title' });
  const elsewhereNote = el('p', { className: 'acc-elsewhere__note' });
  const elsewhereAction = el('div', { className: 'acc-media__actions' });
  elsewhere.append(elsewhereTitle, elsewhereNote, elsewhereAction);
  elsewhere.hidden = true;

  const showGuest = (): void => {
    elsewhereTitle.textContent = ACCOUNT_EMPTY_COPY.guestTitle;
    elsewhereNote.textContent = ACCOUNT_EMPTY_COPY.guestNote;
    elsewhereAction.replaceChildren(
      accButton({
        label: ACCOUNT_GUEST_COPY.action,
        tone: 'primary',
        onClick: () => {
          // 卡片上写着「登录之后就会自动回到这里」，那就得真记住这一页。
          rememberReturnTo(window.location.hash);
          options.navigate('login');
        },
      }),
    );
    elsewhere.hidden = false;
    setBodyVisible(false);
  };

  const showLoading = (): void => {
    elsewhereTitle.textContent = ACCOUNT_EMPTY_COPY.loading;
    elsewhereNote.textContent = '稍等一下，马上就好。';
    elsewhereAction.replaceChildren();
    elsewhere.hidden = false;
    setBodyVisible(false);
  };

  const showError = (message: string): void => {
    elsewhereTitle.textContent = ACCOUNT_EMPTY_COPY.failedTitle;
    elsewhereNote.textContent = message;
    elsewhereAction.replaceChildren(
      accButton({ label: ACCOUNT_EMPTY_COPY.failedAction, tone: 'primary', onClick: () => void load() }),
    );
    elsewhere.hidden = false;
    setBodyVisible(false);
  };

  function setBodyVisible(visible: boolean): void {
    head.element.hidden = !visible;
    tabs.hidden = !visible;
    stage.hidden = !visible;
  }

  /* -------------------------------------------------------------------------
     头部与 tab
  ------------------------------------------------------------------------- */

  const head = createHead();

  const tabs = el('nav', { className: 'account-page__tabs', attrs: { 'aria-label': '账号页面' } });
  const tabButtons = new Map<PanelId, HTMLButtonElement>();

  for (const item of ACCOUNT_TABS) {
    const button = el('button', {
      className: 'account-page__tab',
      attrs: { type: 'button', role: 'tab', 'aria-selected': String(item.id === tab) },
    }, [el('span', { text: item.label })]);
    button.addEventListener('click', () => switchTab(item.id));
    tabButtons.set(item.id, button);
    tabs.append(button);
  }

  /* -------------------------------------------------------------------------
     三个面板
  ------------------------------------------------------------------------- */

  const profileTab: ProfileTabHandle = createProfileTab({
    onEdit: () => switchTab('settings'),
  });
  const homeTab: HomeTabHandle = createHomeTab({
    onEdit: () => switchTab('settings'),
  });
  const settingsTab: SettingsTabHandle = createSettingsTab({
    navigate: options.navigate,
    onData: (next) => {
      data = next;
      head.applyUser(next, getAuthState());
      profileTab.apply(next);
      homeTab.apply(next);
    },
  });

  const panels: Record<PanelId, HTMLElement> = {
    profile: profileTab.element,
    home: homeTab.element,
    settings: settingsTab.element,
  };

  const stage = el('div', { className: 'acc-panels' });
  for (const item of ACCOUNT_TABS) {
    panels[item.id].hidden = item.id !== tab;
    stage.append(panels[item.id]);
  }

  inner.append(elsewhere, head.element, tabs, stage);

  /* -------------------------------------------------------------------------
     切 tab：只切 hidden + replaceState
  ------------------------------------------------------------------------- */

  function switchTab(next: PanelId): void {
    if (next === tab) {
      // 点当前这一项当作「回到顶部」——与导航栏对当前项的处理一致。
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    panels[tab].hidden = true;
    panels[next].hidden = false;
    tab = next;
    for (const [id, button] of tabButtons) {
      button.setAttribute('aria-selected', String(id === next));
    }
    // 把当前数据灌进新出现的面板：切走期间 draft / 资料可能已经变了。
    if (data) {
      if (next === 'profile') profileTab.apply(data);
      else if (next === 'home') homeTab.apply(data);
      else settingsTab.apply(data);
    }
    // `replaceState` 不触发 hashchange → 视图不重建；刷新/分享仍然落回同一 tab。
    const hash = `#account/${next}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }

  /* -------------------------------------------------------------------------
     取数
  ------------------------------------------------------------------------- */

  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    showLoading();
    const result = await fetchMyProfile();
    loading = false;

    if (!result.ok) {
      if (result.status === 401) {
        head.applyUser(null, { status: 'guest' });
        showGuest();
        return;
      }
      showError(result.message);
      return;
    }

    data = result.data;
    elsewhere.hidden = true;
    setBodyVisible(true);
    head.applyUser(data, getAuthState());
    profileTab.apply(data);
    homeTab.apply(data);
    settingsTab.apply(data);
  };

  /* -------------------------------------------------------------------------
     登录态
  ------------------------------------------------------------------------- */

  const applyState = (state: AuthState): void => {
    if (state.status === 'unknown') {
      // 查会话通常 10ms 内就回来；先什么都不画，免得闪一下「请先登录」。
      elsewhere.hidden = true;
      setBodyVisible(false);
      return;
    }
    if (state.status === 'guest') {
      data = null;
      showGuest();
      return;
    }

    head.applyUser(data, state);
    // 换了账号就把手里的资料丢掉（同一标签页内退登再登录）。
    if (data && data.user.id !== state.user.id) {
      data = null;
    }
    if (!data) {
      void load();
      return;
    }
    setBodyVisible(true);
    elsewhere.hidden = true;
  };

  const unsubscribeSession = subscribe(applyState);

  // 任一请求撞到 401（会话过期）：直接降级成客态卡，别留一堆「保存失败」的红字。
  const onUnauthorized = (): void => {
    data = null;
    showGuest();
  };
  window.addEventListener(ACCOUNT_UNAUTHORIZED, onUnauthorized);

  return {
    elements: [section],
    dispose: () => {
      unsubscribeSession();
      window.removeEventListener(ACCOUNT_UNAUTHORIZED, onUnauthorized);
      head.dispose();
      settingsTab.dispose();
    },
  };
}
