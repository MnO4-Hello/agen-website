/**
 * 公开主页（`#u/<用户名>`）。
 *
 * 这一页只做三件事：取数、把四种结果画出来、给本人多两枚按钮（编辑 / 复制链接）。
 * 版式全部交给 `renderProfileSurface()`——和「我的主页」tab 是同一个渲染器，这样
 * 用户在自己页面看到的和访客看到的**不可能长得不一样**。
 *
 * 三条设计约束：
 *
 *   1. **别人的自定义 CSS 永远不渲染**。服务端不下发 `customCss`（见 `routes/profiles.ts`），
 *      这里的 `renderProfileSurface` 调用也刻意不传——两处都不碰，才是真的安全。
 *   2. **「私有」与「不存在」共用一个界面**。服务端对 private + 非本人直接回 404，
 *      前端不做任何区分，否则「404 还是 401」这个差别就能拿来撞用户名。
 *   3. **「仅登录可见」不是错误**，是一张带登录按钮的卡片，并且会记住回跳地址——
 *      登录完自动回到这个主页，不用再翻一次收藏夹。
 *
 * 与 `work-detail.ts` 一致：同步建壳、异步填数据（`router.start()` 必须在首帧内完成）。
 */

import type { AppRoute } from '../app-routes';
import { getAuthState, rememberReturnTo, subscribe } from '../auth/session';
import { PUBLIC_PROFILE_COPY } from '../content/account';
import { fetchPublicProfile, type PublicProfileResult } from '../account/api';
import { accButton, el } from '../account/pieces';
import type { PublicProfile } from '../account/types';
import { editProfileAction, renderProfileSurface } from '../account/views/profile-surface';
import type { RouteView } from '../router';

export interface PublicProfilePageOptions {
  /** 地址栏第二段（`#u/<用户名>`）。大小写不敏感，交给服务端归一。 */
  readonly username: string;
  readonly navigate: (route: AppRoute, param?: string | null) => void;
}

/** 复制链接的兜底提示：`navigator.clipboard` 在非 https / 老浏览器上会直接抛。 */
const COPY_FALLBACK = '复制失败，请手动从地址栏复制。';

export function createPublicProfilePage(options: PublicProfilePageOptions): RouteView {
  const section = el('section', { className: 'profile-page' });
  const stage = el('div', { className: 'profile-page__stage' });
  section.append(stage);

  const baseTitle = document.title;
  let closed = false;
  /** 上一次拿到的结论。用来判断「登录回来了要不要重新取一次」。 */
  let lastKind: PublicProfileResult['kind'] | null = null;
  let loading = false;

  /* -------------------------------------------------------------------------
     非正常态：一张居中的卡片
  ------------------------------------------------------------------------- */

  interface NoticeActions {
    primary?: { label: string; onClick: () => void };
    ghost?: { label: string; onClick: () => void };
  }

  const showNotice = (title: string, note: string, actions: NoticeActions = {}): void => {
    const box = el('div', { className: 'profile-page__notice' }, [
      el('h1', { className: 'profile-page__notice-title', text: title }),
      el('p', { className: 'profile-page__notice-note', text: note }),
    ]);

    const row = el('div', { className: 'profile-page__notice-actions' });
    if (actions.primary) {
      row.append(
        accButton({ label: actions.primary.label, tone: 'primary', onClick: actions.primary.onClick }),
      );
    }
    if (actions.ghost) {
      row.append(
        accButton({ label: actions.ghost.label, tone: 'ghost', onClick: actions.ghost.onClick }),
      );
    }
    if (row.childElementCount > 0) box.append(row);

    stage.replaceChildren(box);
  };

  const showMissing = (): void => {
    document.title = PUBLIC_PROFILE_COPY.missingTitle;
    showNotice(PUBLIC_PROFILE_COPY.missingTitle, PUBLIC_PROFILE_COPY.missingNote, {
      primary: {
        label: PUBLIC_PROFILE_COPY.missingAction,
        onClick: () => options.navigate('home'),
      },
    });
  };

  const showNeedsLogin = (): void => {
    document.title = PUBLIC_PROFILE_COPY.loginTitle;
    showNotice(PUBLIC_PROFILE_COPY.loginTitle, PUBLIC_PROFILE_COPY.loginNote, {
      primary: {
        label: PUBLIC_PROFILE_COPY.loginAction,
        onClick: () => {
          // 卡片上写着「登录完会自动回到这里」，那就得真记住这一页。
          rememberReturnTo(window.location.hash);
          options.navigate('login');
        },
      },
    });
  };

  const showError = (message: string): void => {
    document.title = PUBLIC_PROFILE_COPY.errorTitle;
    showNotice(PUBLIC_PROFILE_COPY.errorTitle, message, {
      primary: { label: PUBLIC_PROFILE_COPY.errorAction, onClick: () => void load() },
    });
  };

  const showLoading = (): void => {
    showNotice('正在读主页…', '稍等一下。');
  };

  /* -------------------------------------------------------------------------
     正正常态：主页皮肤
  ------------------------------------------------------------------------- */

  /**
   * 复制当前地址。
   *
   * `navigator.clipboard` 要求安全上下文（https 或 localhost），局域网内用 IP 访问时
   * 会直接抛——所以留一条 `execCommand` 的老路。两条都失败就如实说，不假装成功。
   */
  const copyLink = async (button: HTMLButtonElement): Promise<void> => {
    const url = window.location.href;
    let done = false;
    try {
      await navigator.clipboard.writeText(url);
      done = true;
    } catch {
      done = false;
    }
    if (!done) {
      const scratch = el('input', { attrs: { type: 'text', readonly: true } });
      scratch.value = url;
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.append(scratch);
      scratch.select();
      try {
        done = document.execCommand('copy');
      } catch {
        done = false;
      }
      scratch.remove();
    }

    // 反馈就地做在按钮上（2 秒后复原）：这里不适合弹出常驻状态条。
    const label = button.querySelector('span');
    button.textContent = '';
    button.append(el('span', { text: done ? PUBLIC_PROFILE_COPY.shareDone : COPY_FALLBACK }));
    window.setTimeout(() => {
      if (closed) return;
      button.textContent = '';
      button.append(label ?? el('span', { text: PUBLIC_PROFILE_COPY.share }));
    }, 2000);
  };

  const renderProfile = (profile: PublicProfile): void => {
    document.title = `${profile.nickname} (@${profile.username})`;

    const actions: HTMLElement[] = [];
    if (profile.isSelf) {
      actions.push(editProfileAction(() => options.navigate('account', 'settings')));
    }
    const share = accButton({ label: PUBLIC_PROFILE_COPY.share, icon: 'link' });
    share.addEventListener('click', () => void copyLink(share));
    actions.push(share);

    /*
     * ⚠️ 这里**不传** `customCss`。服务端本来就不下发，但渲染端也不给入口——
     * 万一以后有人顺手在同一份数据里加了字段，这一行能让「别人的样式」继续进不来。
     * 本人的自定义 CSS 只在「我的主页」tab 里预览（见 `views/home-tab.ts`）。
     */
    stage.replaceChildren(renderProfileSurface({ data: profile, actions }));
  };

  /* -------------------------------------------------------------------------
     取数
  ------------------------------------------------------------------------- */

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    showLoading();

    const username = options.username.trim();
    if (!username) {
      loading = false;
      lastKind = 'missing';
      showMissing();
      return;
    }

    const result = await fetchPublicProfile(username);
    loading = false;
    if (closed) return;
    lastKind = result.kind;

    switch (result.kind) {
      case 'ok':
        renderProfile(result.profile);
        return;
      case 'needs_login':
        showNeedsLogin();
        return;
      case 'missing':
        showMissing();
        return;
      case 'error':
        showError(result.message);
        return;
    }
  }

  /*
   * 登录态变化：
   *
   *   · 只有「上次被拦在门外」（needs_login）才值得重取一次——其他情况服务端给的结果
   *     与登录态无关（private 走 404，不存在走 404）。
   *   · 从登录页回来时视图是重新挂的（`#login` → `#u/xxx` 是换路由），走不到这儿；
   *     这条路径真正覆盖的是「在另一个标签页登录完，切回来」。
   */
  const unsubscribe = subscribe((state) => {
    if (state.status !== 'user') return;
    if (lastKind !== 'needs_login') return;
    void load();
  });

  // 首帧就画「正在读」而不是空白：headless 截图与真人看到的都是同一句话。
  if (getAuthState().status === 'unknown') showLoading();
  void load();

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      unsubscribe();
      document.title = baseTitle;
    },
  };
}
