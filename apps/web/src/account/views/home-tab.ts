/**
 * 「我的主页」tab：本人视角的主页预览。
 *
 * 与公开页 `#u/<用户名>` 用的是同一个渲染器（`profile-surface.ts`），差别只有两处：
 *
 *   · 这里可以切「游客视角」——按隐私开关把字段在本地裁一遍，看看别人会看到什么；
 *   · 自定义 CSS 只在这里生效（服务端不下发别人的 CSS，见 `routes/profiles.ts`）。
 *
 * 这里重画是安全的：整块没有输入框。
 */

import { ACCOUNT_TAB_COPY, VISIBILITY_OPTIONS } from '../../content/account';
import { accBlock, accButton, accSegmented, el } from '../pieces';
import { profileHref } from '../api';
import type { MyProfile, PublicProfile } from '../types';
import { renderProfileSurface } from './profile-surface';

export interface HomeTabOptions {
  onEdit: () => void;
}

export interface HomeTabHandle {
  readonly element: HTMLElement;
  apply(data: MyProfile): void;
}

/**
 * 在本地把资料按隐私开关裁成某一种视角看到的样子。
 *
 * 与 `apps/api/src/users/profile-validate.ts` 的 `toPublicProfile()` 一一对应。
 * 为什么在前端再实现一遍而不是问后端要：切一次视角就多一次请求、还会闪；
 * 而这份逻辑只决定「预览里显不显示」，真实可见性永远以服务端为准。
 */
function asView(data: MyProfile, isSelf: boolean): PublicProfile {
  const { user, profile, meta, systemBadges } = data;
  const canSee = (field: keyof typeof profile.privacy): boolean => {
    const level = profile.privacy[field];
    if (level === 'hidden') return false;
    if (level === 'self') return isSelf;
    return true;
  };

  const customBadges = canSee('badges') ? profile.badges : [];
  const tags = canSee('tags') ? profile.tags : [];
  const born = new Date(user.createdAt).getTime();
  const days = Number.isFinite(born) ? Math.max(0, Math.floor((Date.now() - born) / 86_400_000)) : 0;

  return {
    username: user.username,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    isSelf,
    visibility: profile.visibility,
    coverUrl: profile.coverUrl,
    backgroundUrl: profile.backgroundUrl,
    theme: profile.theme,
    signature: canSee('signature') && profile.signature ? profile.signature : null,
    bio: canSee('bio') && profile.bio ? profile.bio : null,
    gender: canSee('gender') && profile.gender !== 'none' ? profile.gender : null,
    birthday: canSee('birthday') && profile.birthday ? profile.birthday : null,
    region: canSee('region') && profile.region ? profile.region : null,
    lastLoginAt: canSee('lastLogin') ? meta.lastLoginAt : null,
    socials: canSee('socials') && profile.socials.length > 0 ? profile.socials : null,
    tags: tags.length > 0 ? tags : null,
    customBadges: customBadges.length > 0 ? customBadges : null,
    systemBadges,
    stats: { days, badges: systemBadges.length + customBadges.length, tags: tags.length },
  };
}

export function createHomeTab(options: HomeTabOptions): HomeTabHandle {
  const element = el('div', { className: 'acc-panel' });
  element.append(el('p', { className: 'acc-panel__lead', text: ACCOUNT_TAB_COPY.home.note }));

  let view: 'self' | 'guest' = 'self';
  let current: MyProfile | null = null;

  const viewToggle = accSegmented<'self' | 'guest'>({
    options: [
      { value: 'self', label: '本人视角' },
      { value: 'guest', label: '游客视角' },
    ],
    value: 'self',
    compact: true,
    onChange: (next) => {
      view = next;
      paint();
    },
  });

  const openLink = accButton({
    label: '打开公开主页',
    tone: 'default',
    icon: 'chevron',
    onClick: () => {
      if (current) window.location.hash = profileHref(current.user.username);
    },
  });

  const bar = el('div', { className: 'acc-preview__bar' }, [
    el('div', { className: 'acc-preview__bar' }, [viewToggle.element]),
    el('div', { className: 'acc-preview__bar' }, [
      openLink,
      accButton({ label: '改外观', tone: 'ghost', icon: 'pencil', onClick: options.onEdit }),
    ]),
  ]);

  const stage = el('div', { className: 'acc-preview__stage' });
  const hint = el('p', { className: 'acc-preview__note' });

  const visibilityBlock = accBlock({
    title: '现在谁能看',
    note: '在「设置 → 隐私」里可以改。',
  });
  const visibilityText = el('p', { className: 'acc-preview__note' });
  visibilityBlock.body.append(visibilityText);
  visibilityBlock.element.hidden = true;

  element.append(bar, hint, visibilityBlock.element, stage);

  const paint = (): void => {
    if (!current) return;
    const isSelf = view === 'self';

    stage.replaceChildren(
      renderProfileSurface({
        data: asView(current, isSelf),
        // 自定义 CSS 只在本人视角生效：游客视角要看「没有自己样式」时的样子。
        customCss: isSelf ? current.profile.customCss : undefined,
        flat: true,
      }),
    );

    hint.textContent = isSelf
      ? '这是你自己看到的主页，包含所有隐藏字段与你写的自定义 CSS。'
      : '这是没登录的人看到的主页：标记为「仅自己 / 隐藏」的字段已经消失。';
  };

  return {
    element,
    apply(data: MyProfile): void {
      current = data;

      const option = VISIBILITY_OPTIONS.find((item) => item.value === data.profile.visibility);
      visibilityText.textContent = option
        ? `${option.label} —— ${option.note}`
        : '所有人可见。';
      visibilityBlock.element.hidden = false;

      paint();
    },
  };
}
