/**
 * 博客的头像。
 *
 * 登录用户直接复用 `components/avatar.ts`（首字 + 六档派生色）；**游客用一个人形剪影**，
 * 因为「游客」这两个字当首字会画成一个大大的「游」，看起来像另一个人而不是「未登录」。
 *
 * 剪影用内联 SVG 画，不新增图片资源：这个模块只在博客里用，为 20 行路径去多一个
 * `public/` 文件（还要考虑深浅色）不划算。
 */

import { createAvatar } from '../components/avatar';
import type { AuthorView } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

function guestAvatar(): HTMLElement {
  const root = document.createElement('span');
  root.className = 'bl-avatar bl-avatar--guest';
  root.setAttribute('aria-hidden', 'true');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');

  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '12');
  head.setAttribute('cy', '8.4');
  head.setAttribute('r', '3.6');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M5 20c0-3.5 3.1-5.6 7-5.6s7 2.1 7 5.6');

  svg.append(head, body);
  root.append(svg);
  return root;
}

/**
 * 按作者类型给头像。
 *
 * `size` 只影响博客自己的样式钩子（`.bl-avatar` 的尺寸由外层容器定），不传进
 * `createAvatar`——那边的 `sm` 是给导航栏用的尺寸，塞进楼层会太大。
 */
export function createBlogAvatar(author: AuthorView): HTMLElement {
  if (author.kind === 'guest' || !author.nickname) return guestAvatar();
  const avatar = createAvatar({ nickname: author.nickname, avatarUrl: author.avatarUrl });
  avatar.classList.add('bl-avatar');
  return avatar;
}
