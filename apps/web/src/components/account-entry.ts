/**
 * 导航栏右上角的账号位：未登录是「登录 / 注册」两个链接，已登录是头像 + 昵称 + 下拉菜单。
 *
 * 交互照抄 B 站那种手感：**悬停头像时头像放大、菜单从下面淡入**。但实现上刻意
 * **不依赖 CSS `:hover`**——`:hover` 管不了「从头像斜着移进菜单时中间那一小段空隙」，
 * 也管不了 Escape、点击外部、以及触摸设备。所以开关状态只有一个 JS 布尔值，
 * CSS 只负责把它画出来。
 *
 * 三个容易踩的细节：
 *
 *   1. **打开延迟 80ms / 关闭延迟 160ms**。关闭延迟比打开长，是为了让指针在
 *      「头像 → 菜单」的斜向移动中即使短暂离开也来得及回来。
 *   2. **菜单自己带 `padding-top` 当桥**。视觉上的 8px 间隙画在 padding 里，
 *      那块区域仍然属于 `.account`，指针根本不会离开。
 *   3. **导航栏收起成胶囊时必须关菜单**。收起态把账号位整个隐藏了，菜单要是还开着，
 *      就会浮在一个已经不存在的按钮下面（`is-collapsed` 由 hero-parallax 加）。
 */

import type { PublicUser } from '../auth/api';
import type { AuthState } from '../auth/session';
import { ACCOUNT_ENTRY_COPY, ACCOUNT_MENU, ROLE_LABEL } from '../content/auth';
import { createAvatar } from './avatar';

export interface AccountEntryOptions {
  /** 点击「登录 / 注册」时调用：此时地址栏还是原页面，登录完要能跳回来。 */
  onRememberReturnTo: (hash: string) => void;
  onLogout: () => void;
  /** 页头节点，用来监听 `is-collapsed`。 */
  header: HTMLElement;
}

export interface AccountEntryHandle {
  readonly element: HTMLElement;
  setState(state: AuthState): void;
  close(): void;
  dispose(): void;
}

const OPEN_DELAY = 80;
const CLOSE_DELAY = 160;

export function createAccountEntry(options: AccountEntryOptions): AccountEntryHandle {
  const root = document.createElement('div');
  root.className = 'site-header__account account';
  root.dataset.state = 'unknown';

  let button: HTMLButtonElement | null = null;
  let menu: HTMLElement | null = null;
  let openTimer = 0;
  let closeTimer = 0;
  let isOpen = false;
  let lastKey = '';

  /* -------------------------------------------------------------------------
     开关
  ------------------------------------------------------------------------- */

  const clearTimers = (): void => {
    if (openTimer) window.clearTimeout(openTimer);
    if (closeTimer) window.clearTimeout(closeTimer);
    openTimer = 0;
    closeTimer = 0;
  };

  function setOpen(next: boolean, returnFocus = false): void {
    if (!menu || !button) return;
    isOpen = next;
    root.classList.toggle('is-open', next);
    button.setAttribute('aria-expanded', String(next));
    menu.setAttribute('aria-hidden', String(!next));
    if (!next && returnFocus) button.focus();
  }

  const openSoon = (): void => {
    if (isOpen) return;
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = 0;
    if (openTimer) return;
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      setOpen(true);
    }, OPEN_DELAY);
  };

  const closeSoon = (): void => {
    if (openTimer) window.clearTimeout(openTimer);
    openTimer = 0;
    if (!isOpen || closeTimer) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      setOpen(false);
    }, CLOSE_DELAY);
  };

  /* -------------------------------------------------------------------------
     渲染
  ------------------------------------------------------------------------- */

  const guestContent = (): DocumentFragment => {
    const fragment = document.createDocumentFragment();
    const login = document.createElement('a');
    login.className = 'account__link';
    login.href = '#login';
    login.textContent = ACCOUNT_ENTRY_COPY.login;

    const separator = document.createElement('span');
    separator.className = 'account__separator';
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '/';

    const register = document.createElement('a');
    register.className = 'account__link';
    register.href = '#login/register';
    register.textContent = ACCOUNT_ENTRY_COPY.register;

    for (const link of [login, register]) {
      // 只记录落点，不拦默认行为：跳转仍然交给路由的 `hashchange`。
      link.addEventListener('click', () => options.onRememberReturnTo(window.location.hash));
    }

    fragment.append(login, separator, register);
    return fragment;
  };

  const userContent = (user: PublicUser): DocumentFragment => {
    const fragment = document.createDocumentFragment();

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'account__button';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'site-account-menu');
    trigger.setAttribute('aria-label', ACCOUNT_ENTRY_COPY.menuLabel);
    trigger.append(
      createAvatar({ nickname: user.nickname, avatarUrl: user.avatarUrl, size: 'sm' }),
    );

    const name = document.createElement('span');
    name.className = 'account__name';
    name.textContent = user.nickname;
    trigger.append(name);

    const chevron = document.createElement('span');
    chevron.className = 'account__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(chevron);

    trigger.addEventListener('click', (event) => {
      // 触摸设备没有 hover，点击是打开菜单的唯一入口。
      event.stopPropagation();
      if (isOpen) setOpen(false);
      else setOpen(true);
    });

    const panel = document.createElement('div');
    panel.className = 'account__menu';
    panel.id = 'site-account-menu';
    panel.setAttribute('aria-hidden', 'true');

    const inner = document.createElement('div');
    inner.className = 'account__panel';

    const meta = document.createElement('div');
    meta.className = 'account__meta';

    const metaName = document.createElement('span');
    metaName.className = 'account__meta-name';
    metaName.textContent = user.nickname;

    const metaUser = document.createElement('span');
    metaUser.className = 'account__meta-user';
    metaUser.textContent = `@${user.username}`;
    // 用户名只用于登录、不对外展示——但这是「本人」的菜单，看到自己的用户名不算展示。
    metaUser.title = '用户名（仅用于登录）';

    const role = document.createElement('span');
    role.className = 'account__role';
    role.textContent = ROLE_LABEL[user.role];

    meta.append(metaName, role, metaUser);
    inner.append(meta);

    const isAdmin = user.role === 'admin' || user.role === 'owner';
    for (const item of ACCOUNT_MENU) {
      if (item.adminOnly && !isAdmin) continue;
      const link = document.createElement('a');
      link.className = 'account__item';
      link.href = item.href ?? '#';
      link.textContent = item.label;
      if (item.href && !item.href.startsWith('#')) {
        // 后台是另一个入口（独立 HTML），开新标签，不打断当前页面。
        link.target = '_blank';
        link.rel = 'noopener';
      }
      link.addEventListener('click', () => setOpen(false));
      inner.append(link);
    }

    const divider = document.createElement('div');
    divider.className = 'account__divider';
    inner.append(divider);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'account__item account__item--danger';
    logout.textContent = ACCOUNT_ENTRY_COPY.logout;
    logout.addEventListener('click', () => {
      setOpen(false);
      options.onLogout();
    });
    inner.append(logout);

    panel.append(inner);
    fragment.append(trigger, panel);

    button = trigger;
    menu = panel;
    return fragment;
  };

  /* -------------------------------------------------------------------------
     事件（挂在 root 上，子节点重建不影响）
  ------------------------------------------------------------------------- */

  root.addEventListener('pointerenter', (event) => {
    // 触摸设备忽略：iOS 会先派发 pointerenter 再派发 click，两个都响应等于「点了没开」。
    if (event.pointerType !== 'mouse') return;
    openSoon();
  });

  root.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    closeSoon();
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen) return;
    event.stopPropagation();
    setOpen(false, true);
  });

  root.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    // relatedTarget 为 null = 焦点离开了窗口，也当作离开处理。
    if (next && root.contains(next)) return;
    setOpen(false);
  });

  const onDocumentPointerDown = (event: Event): void => {
    if (!isOpen) return;
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    setOpen(false);
  };
  document.addEventListener('pointerdown', onDocumentPointerDown, true);

  // 收起成胶囊时把菜单关掉：那时账号位整个不可见了，菜单不能留在空中。
  const collapseObserver = new MutationObserver(() => {
    if (options.header.classList.contains('is-collapsed')) setOpen(false);
  });
  collapseObserver.observe(options.header, { attributes: true, attributeFilter: ['class'] });

  /* -------------------------------------------------------------------------
     对外
  ------------------------------------------------------------------------- */

  const setState = (state: AuthState): void => {
    // 同一份数据重复下发时不重建 DOM：`subscribe` 会在每次 hydrate 后回调，
    // 重建会让正在悬停的菜单瞬间消失。
    //
    // ⚠️ `avatarUrl` 必须在 key 里：换头像走的是 `applyUser()`，昵称与角色都没变，
    // 少了这一段导航栏就会一直顶着旧头像（而且看起来像「上传失败」）。
    const key =
      state.status === 'user'
        ? `user:${state.user.id}:${state.user.nickname}:${state.user.role}:${state.user.avatarUrl}`
        : state.status;
    if (key === lastKey) return;
    lastKey = key;

    // 直接复位而不是走 `setOpen(false)`：第一次渲染时 button / menu 都还是 null，
    // 那个函数会提前 return，`is-open` 类就会留在根节点上。
    setOpen(false);
    clearTimers();
    isOpen = false;
    root.classList.remove('is-open');
    button = null;
    menu = null;
    root.classList.toggle('account--guest', state.status !== 'user');
    root.dataset.state = state.status;
    root.replaceChildren(
      state.status === 'user' ? userContent(state.user) : guestContent(),
    );
  };

  return {
    element: root,
    setState,
    close: () => setOpen(false),
    dispose: () => {
      clearTimers();
      collapseObserver.disconnect();
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    },
  };
}
