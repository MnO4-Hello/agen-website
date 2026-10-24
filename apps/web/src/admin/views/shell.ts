/**
 * 登录之后的外壳：左边功能卡，右边内容。
 *
 * 这里只做三件事：
 *   1. 画左侧导航（哪些能用、哪些还在筹备）；
 *   2. 切视图时**先 dispose 旧视图**再建新的（控制台的 SSE、编辑器的脏状态都靠这步收尾）；
 *   3. 顶部标题 / 底部账号与登出。
 *
 * 具体功能都在 `views/console.ts` 与 `views/files.ts`；外壳不碰它们的内部状态。
 *
 * `views` 参数是给 DEV 截图用的注入点（见 `preview.ts`）：不传就用真实视图。
 */

import type { SessionState } from '../api';
import { el, icon, type IconName } from '../ui';
import { createConsoleView } from './console';
import { createFilesView } from './files';
import { createWorksView } from './works';
import type { AdminView } from './view';

export type AdminViewId = 'console' | 'files' | 'works' | 'content' | 'settings';

export type AdminViewFactory = () => AdminView;

interface NavItem {
  id: AdminViewId;
  label: string;
  description: string;
  icon: IconName;
  /** `soon` = 只占位，点了没反应（不弹「施工中」的假提示，灰着就说明了）。 */
  status: 'ready' | 'soon';
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'console', label: '控制台', description: '后端进程的实时输出', icon: 'terminal', status: 'ready' },
  { id: 'files', label: '文件管理', description: '站点资源 / 截图 / 文档', icon: 'folder', status: 'ready' },
  /*
   * 「作品」是独立一项，没有并进「内容」。
   *
   * `content` 的语义是「文章与留言」，而作品是另一套数据模型（两种模式、媒体、排序、
   * 发布状态）与另一个编辑器。塞进同一个视图，要么标签撒谎，要么得再加一层二级 tab，
   * 还会让 `?view=` 深链的含义变模糊。多一个导航项是最小的改动。
   */
  { id: 'works', label: '作品', description: '列表、详情与首页作品墙', icon: 'grid', status: 'ready' },
  { id: 'content', label: '内容', description: '文章与留言', icon: 'pen', status: 'soon' },
  { id: 'settings', label: '设置', description: '站点与账号', icon: 'settings', status: 'soon' },
];

const DEFAULT_VIEWS: Partial<Record<AdminViewId, AdminViewFactory>> = {
  console: createConsoleView,
  files: createFilesView,
  works: createWorksView,
};

export interface ShellOptions {
  onSignOut: () => void;
  /** DEV 截图注入用；生产走默认视图。 */
  views?: Partial<Record<AdminViewId, AdminViewFactory>>;
  /** 首屏视图，默认控制台。 */
  initialView?: AdminViewId;
}

export interface ShellHandle {
  dispose: () => void;
}

export function renderShell(root: HTMLElement, session: SessionState, options: ShellOptions): ShellHandle {
  const factories: Partial<Record<AdminViewId, AdminViewFactory>> = { ...DEFAULT_VIEWS, ...options.views };

  let currentView: AdminView | null = null;
  let currentId: AdminViewId | null = null;
  let disposed = false;

  const navButtons = new Map<AdminViewId, HTMLButtonElement>();

  const list = el('nav', { className: 'admin-nav', attrs: { 'aria-label': '管理功能' } });
  for (const item of NAV_ITEMS) {
    const ready = item.status === 'ready' && Boolean(factories[item.id]);
    const button = el('button', {
      className: `admin-navitem${ready ? '' : ' is-soon'}`,
      attrs: {
        type: 'button',
        disabled: ready ? null : true,
        title: ready ? item.description : '还没做',
      },
    });
    button.append(
      el('span', { className: 'admin-navitem__icon' }, [icon(item.icon, 18)]),
      el('span', { className: 'admin-navitem__text' }, [
        el('span', { className: 'admin-navitem__label', text: item.label }),
        el('span', { className: 'admin-navitem__desc', text: ready ? item.description : '筹备中' }),
      ]),
    );
    if (ready) button.addEventListener('click', () => open(item.id));
    navButtons.set(item.id, button);
    list.append(button);
  }

  const brand = el('div', { className: 'admin-brand' }, [
    el('span', { className: 'admin-brand__mark', text: '根' }),
    el('span', { className: 'admin-brand__text' }, [
      el('span', { className: 'admin-brand__title', text: '管理后台' }),
      el('span', { className: 'admin-brand__sub', text: 'agen.website' }),
    ]),
  ]);

  const sideFoot = el('div', { className: 'admin-side__foot' }, [
    el('span', { className: 'admin-avatar', text: (session.user ?? 'A').slice(0, 1).toUpperCase() }),
    el('span', { className: 'admin-user' }, [
      el('span', { className: 'admin-user__name', text: session.user ?? '管理员' }),
      el('span', { className: 'admin-user__role', text: '已登录' }),
    ]),
    (() => {
      const signOut = el('button', {
        className: 'admin-iconbtn',
        attrs: { type: 'button', title: '退出登录', 'aria-label': '退出登录' },
      });
      signOut.append(icon('logout', 16));
      signOut.addEventListener('click', options.onSignOut);
      return signOut;
    })(),
  ]);

  const side = el('aside', { className: 'admin-side' }, [brand, list, sideFoot]);

  const heading = el('h1', { className: 'admin-topbar__title', text: '控制台' });
  const sub = el('p', { className: 'admin-topbar__sub', text: '后端进程的实时输出' });
  const siteLink = el('a', {
    className: 'admin-link',
    text: '打开站点',
    attrs: { href: '/', target: '_blank', rel: 'noreferrer' },
  });

  const topbar = el('header', { className: 'admin-topbar' }, [
    el('div', { className: 'admin-topbar__text' }, [heading, sub]),
    siteLink,
  ]);

  const body = el('div', { className: 'admin-body' });
  const main = el('main', { className: 'admin-main' }, [topbar, body]);
  const shell = el('div', { className: 'admin-shell' }, [side, main]);

  root.classList.add('admin--shell');
  root.replaceChildren(shell);

  function open(id: AdminViewId): void {
    if (disposed) return;
    const item = NAV_ITEMS.find((entry) => entry.id === id);
    if (!item || item.status !== 'ready') return;
    const factory = factories[id];
    if (!factory) return;
    if (currentId === id) return;

    currentView?.dispose();
    currentView = null;
    body.replaceChildren();

    for (const [key, node] of navButtons) {
      const active = key === id;
      node.classList.toggle('is-active', active);
      if (active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }

    heading.textContent = item.label;
    sub.textContent = item.description;
    document.title = `${item.label} · 管理后台`;

    currentId = id;
    const view = factory();
    currentView = view;
    body.append(view.element);
    body.scrollTop = 0;
  }

  open(options.initialView ?? 'console');

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      currentView?.dispose();
      currentView = null;
      root.classList.remove('admin--shell');
      root.replaceChildren();
      document.title = '管理后台 · 阿根';
    },
  };
}
