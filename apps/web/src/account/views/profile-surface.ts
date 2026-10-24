/**
 * 主页「皮肤」的唯一渲染器。
 *
 * 三个地方共用它：**我的主页** tab 的预览、公开主页 `#u/<用户名>`、以及预览里的
 * 「游客视角」。共用而不是各写一份，是因为这一块最容易被改歪——一旦两处渲染不一致，
 * 用户在自己页面看到的和访客看到的就不是同一张脸了。
 *
 * 纯函数，返回 DOM 节点，没有内部状态。换视角时整块重画是对的：这里面没有任何
 * 输入框，重画不会丢用户正在编辑的内容。
 */

import { createAvatar } from '../../components/avatar';
import { GENDER_LABEL } from '../../content/account';
import {
  formatDate,
  formatDateTime,
  systemBadgeChip,
  customBadgeChip,
  el,
  accButton,
} from '../pieces';
import type { PublicProfile } from '../types';
import { applyScopedCss } from '../css-scope';

export interface ProfileSurfaceOptions {
  data: PublicProfile;
  /**
   * 只有**本人预览**才传自定义 CSS。公开页永远不渲染别人的样式——
   * 那一整类注入/XSS 面积就此消失。
   */
  customCss?: string;
  /** 右上角的操作按钮（公开页给「复制链接」，本人给「编辑」）。 */
  actions?: HTMLElement[];
  /** 预览模式下减弱阴影，避免和外面的卡片撞在一起。 */
  flat?: boolean;
}

function setTheme(root: HTMLElement, data: PublicProfile): void {
  root.style.setProperty('--profile-accent', data.theme.accent);
  root.style.setProperty('--profile-accent-strong', data.theme.accentStrong);
  root.style.setProperty('--profile-surface', data.theme.surface);
  root.style.setProperty('--profile-text', data.theme.text);
}

function statBlock(value: string, label: string): HTMLElement {
  return el('div', { className: 'uprofile__stat' }, [
    el('span', { className: 'uprofile__stat-value', text: value }),
    el('span', { className: 'uprofile__stat-label', text: label }),
  ]);
}

function sectionBlock(title: string, body: HTMLElement): HTMLElement {
  return el('section', { className: 'uprofile__section' }, [
    el('h3', { className: 'uprofile__section-title', text: title }),
    body,
  ]);
}

export function renderProfileSurface(options: ProfileSurfaceOptions): HTMLElement {
  const { data } = options;
  const root = el('article', { className: 'uprofile' });
  setTheme(root, data);

  if (options.flat) root.classList.add('is-flat');
  // 没有封面图时横幅按 3:1 铺开会是一大片空白——给个矮一号的版本（见 CSS `.is-bare`）。
  if (!data.coverUrl) root.classList.add('is-bare');
  if (data.backgroundUrl) root.style.backgroundImage = `url("${data.backgroundUrl}")`;

  if (data.backgroundUrl) root.append(el('span', { className: 'uprofile__scrim' }));

  // ① 横幅 + 头像 + 名字
  const banner = el('div', { className: 'uprofile__banner' });
  if (data.coverUrl) banner.style.backgroundImage = `url("${data.coverUrl}")`;

  const avatarWrap = el('span', { className: 'uprofile__avatar' }, [
    createAvatar({ nickname: data.nickname, avatarUrl: data.avatarUrl, size: 'lg' }),
  ]);

  const identity = el('div', { className: 'uprofile__identity' }, [
    el('h1', { className: 'uprofile__name', text: data.nickname }),
    el('p', { className: 'uprofile__handle', text: `@${data.username}` }),
  ]);
  if (data.signature) {
    identity.append(el('p', { className: 'uprofile__signature', text: data.signature }));
  }

  const hero = el('header', { className: 'uprofile__hero' }, [avatarWrap, identity]);
  if (options.actions && options.actions.length > 0) {
    hero.append(el('div', { className: 'uprofile__actions' }, options.actions));
  }

  // ② 统计条
  const stats = el('div', { className: 'uprofile__stats' }, [
    statBlock(String(data.stats.days), '加入天数'),
    statBlock(String(data.stats.badges), '徽章'),
    statBlock(String(data.stats.tags), '标签'),
  ]);

  const body = el('div', { className: 'uprofile__body' }, [stats]);

  // ③ 简介
  if (data.bio) {
    body.append(sectionBlock('简介', el('p', { className: 'uprofile__text', text: data.bio })));
  }

  // ④ 标签
  if (data.tags && data.tags.length > 0) {
    body.append(
      sectionBlock(
        '标签',
        el(
          'div',
          { className: 'uprofile__tags' },
          data.tags.map((tag) => el('span', { className: 'uprofile__tag', text: tag })),
        ),
      ),
    );
  }

  // ⑤ 徽章：系统在前，自建在后，两类形状不同
  const badgeNodes: HTMLElement[] = [
    ...data.systemBadges.map((badge) => systemBadgeChip(badge)),
    ...(data.customBadges ?? []).map((badge) => customBadgeChip(badge)),
  ];
  if (badgeNodes.length > 0) {
    body.append(sectionBlock('徽章', el('div', { className: 'uprofile__badges' }, badgeNodes)));
  }

  // ⑥ 社交链接
  if (data.socials && data.socials.length > 0) {
    const links = data.socials.map((link) => {
      const anchor = el('a', {
        className: 'uprofile__link',
        text: link.label,
        attrs: { href: link.url, target: '_blank', rel: 'noopener noreferrer me' },
      });
      return anchor;
    });
    body.append(sectionBlock('找到我', el('div', { className: 'uprofile__links' }, links)));
  }

  // ⑦ 资料
  const facts: HTMLElement[] = [];
  const push = (term: string, value: string | null): void => {
    if (!value) return;
    facts.push(
      el('span', { className: 'uprofile__fact-term', text: term }),
      el('span', { className: 'uprofile__fact-value', text: value }),
    );
  };
  push('地区', data.region);
  push('性别', data.gender ? GENDER_LABEL[data.gender] : null);
  push('生日', data.birthday);
  push('加入于', formatDate(data.createdAt));
  push('最后登录', data.lastLoginAt ? formatDateTime(data.lastLoginAt) : null);

  if (facts.length > 0) {
    body.append(
      sectionBlock('资料', el('div', { className: 'uprofile__facts' }, facts)),
    );
  }

  // ⑧ 什么都没有时的空态（只在公开页出现：本人会看到「去完善资料」）
  if (body.childElementCount <= 1 && !data.bio) {
    body.append(el('p', { className: 'uprofile__empty', text: '这个主页还是空的。' }));
  }

  const inner = el('div', { className: 'uprofile__inner' }, [banner, hero, body]);
  root.append(inner);

  if (options.customCss) {
    // `<style>` 会被 prepend 到 root 里，跟着 root 一起消失。
    applyScopedCss(root, options.customCss);
  }

  return root;
}

/** 公开页右上角的「编辑我的主页」按钮（只有本人看得到）。 */
export function editProfileAction(onClick: () => void): HTMLElement {
  return accButton({ label: '编辑我的主页', tone: 'primary', icon: 'pencil', onClick });
}
