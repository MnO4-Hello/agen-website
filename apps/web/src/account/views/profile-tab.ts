/**
 * 「个人中心」tab：把账号资料读出来展示。
 *
 * 这一页是**只读**的，所以允许整块重画（`apply()` 里 `replaceChildren`）——里面没有
 * 任何输入框，不存在「重建冲掉用户输入」的问题。设置页没有这个自由，见 `settings-tab.ts`。
 */

import { ACCOUNT_TAB_COPY, GENDER_LABEL, IDENTITY_COPY } from '../../content/account';
import { ROLE_LABEL } from '../../content/auth';
import {
  accBlock,
  accButton,
  byteLength,
  charCount,
  customBadgeChip,
  el,
  factRow,
  formatDate,
  formatDateTime,
  systemBadgeChip,
  tagChip,
} from '../pieces';
import { LIMITS, type MyProfile } from '../types';

export interface ProfileTabOptions {
  onEdit: () => void;
}

export interface ProfileTabHandle {
  readonly element: HTMLElement;
  apply(data: MyProfile): void;
}

export function createProfileTab(options: ProfileTabOptions): ProfileTabHandle {
  const element = el('div', { className: 'acc-panel' });
  element.append(el('p', { className: 'acc-panel__lead', text: ACCOUNT_TAB_COPY.profile.note }));

  const body = el('div', { className: 'acc-tabbody' });
  element.append(body);

  const render = (data: MyProfile): void => {
    const { user, profile, meta, systemBadges } = data;

    /* 统计 */
    const stats = accBlock({ title: '一眼看完' });
    const born = new Date(user.createdAt).getTime();
    const days = Number.isFinite(born) ? Math.max(0, Math.floor((Date.now() - born) / 86_400_000)) : 0;
    const counters = el('div', { className: 'uprofile__stats' }, [
      el('div', { className: 'uprofile__stat' }, [
        el('span', { className: 'uprofile__stat-value', text: String(days) }),
        el('span', { className: 'uprofile__stat-label', text: '加入天数' }),
      ]),
      el('div', { className: 'uprofile__stat' }, [
        el('span', { className: 'uprofile__stat-value', text: String(systemBadges.length + profile.badges.length) }),
        el('span', { className: 'uprofile__stat-label', text: '徽章' }),
      ]),
      el('div', { className: 'uprofile__stat' }, [
        el('span', { className: 'uprofile__stat-value', text: String(profile.tags.length) }),
        el('span', { className: 'uprofile__stat-label', text: '标签' }),
      ]),
      el('div', { className: 'uprofile__stat' }, [
        el('span', { className: 'uprofile__stat-value', text: String(profile.socials.length) }),
        el('span', { className: 'uprofile__stat-label', text: '链接' }),
      ]),
    ]);
    stats.body.append(counters);

    /* 基本资料 */
    const facts = accBlock({
      title: '基本资料',
      note: IDENTITY_COPY.note,
      action: accButton({ label: '去设置改', tone: 'ghost', icon: 'pencil', onClick: options.onEdit }),
    });
    const list = el('div', { className: 'acc-facts' });
    const rows = [
      factRow('昵称', user.nickname),
      factRow('用户名', `@${user.username}`),
      factRow('邮箱', user.email),
      factRow('身份', ROLE_LABEL[user.role]),
      factRow('性别', profile.gender === 'none' ? '未填写' : GENDER_LABEL[profile.gender]),
      factRow('生日', profile.birthday || '未填写'),
      factRow('地区', profile.region || '未填写'),
      factRow('注册时间', formatDate(user.createdAt)),
      factRow('最后登录', meta.lastLoginAt ? formatDateTime(meta.lastLoginAt) : '—'),
      factRow('资料更新', meta.updatedAt ? formatDateTime(meta.updatedAt) : '—'),
    ].filter((node): node is HTMLElement => node !== null);
    list.append(...rows);
    facts.body.append(list);

    /* 签名 + 简介 */
    const about = accBlock({ title: '关于我', note: '这两段会显示在你的主页上（受隐私开关控制）。' });
    about.body.append(
      el('div', { className: 'acc-facts' }, [
        el('span', { className: 'acc-fact__term', text: IDENTITY_COPY.signature }),
        el('span', {
          className: 'acc-fact__value',
          text: profile.signature || '还没写一句话签名',
        }),
      ]),
    );
    about.body.append(
      el('p', {
        className: 'acc-prose',
        text: profile.bio || '还没写简介。',
      }),
    );

    /* 标签 */
    const tags = accBlock({
      title: '标签',
      note: `最多 ${LIMITS.tagCount} 个，看不顺眼就去设置里删掉。`,
    });
    tags.body.append(
      profile.tags.length > 0
        ? el('div', { className: 'acc-badges' }, profile.tags.map((tag) => tagChip(tag)))
        : el('p', { className: 'acc-muted', text: '还没有标签。' }),
    );

    /* 徽章 */
    const badges = accBlock({
      title: '徽章',
      note: '深色实心的是系统给的，描边的是你自己造的。',
    });
    const badgeNodes = [
      ...systemBadges.map((badge) => systemBadgeChip(badge)),
      ...profile.badges.map((badge) => customBadgeChip(badge)),
    ];
    badges.body.append(
      badgeNodes.length > 0
        ? el('div', { className: 'acc-badges' }, badgeNodes)
        : el('p', { className: 'acc-muted', text: '还没有徽章。' }),
    );

    /* 社交链接 */
    const links = accBlock({ title: '社交链接' });
    if (profile.socials.length > 0) {
      const wrap = el('div', { className: 'uprofile__links' });
      for (const link of profile.socials) {
        wrap.append(
          el('a', {
            className: 'uprofile__link',
            text: link.label,
            attrs: { href: link.url, target: '_blank', rel: 'noopener noreferrer me' },
          }),
        );
      }
      links.body.append(wrap);
    } else {
      links.body.append(el('p', { className: 'acc-muted', text: '还没有链接。' }));
    }

    /* 自定义 CSS 的体积提示：8KB 很容易在没意识到的时候撞上 */
    let cssBlock: HTMLElement | null = null;
    if (profile.customCss) {
      const css = accBlock({ title: '自定义 CSS', note: '它只作用于你的主页，不会改动全站。' });
      css.body.append(
        el('p', {
          className: 'acc-muted',
          text: `${charCount(profile.customCss)} 个字符 / ${byteLength(profile.customCss)} 字节（上限 ${
            LIMITS.cssBytes
          } 字节）。`,
        }),
      );
      cssBlock = css.element;
    }

    body.replaceChildren(
      stats.element,
      facts.element,
      about.element,
      tags.element,
      badges.element,
      links.element,
      ...(cssBlock ? [cssBlock] : []),
    );
  };

  return { element, apply: render };
}
