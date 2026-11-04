/**
 * 「关于我」页（`#about`）。
 *
 * 纯静态内容页：不取数、没有 Loading/Error 态，`start()` 那一刻就把整页建好（截图钩子
 * 与首屏可读性都靠这一点）。所以这里没有 `AbortController`，`dispose()` 只做一件事——
 * 把标签页标题还原回去。
 *
 * 两条硬约束：
 * ① 返回的 `elements` 只能放**一个** `<section>`，它会是 `.app-shell` 的直接子元素。
 *    截图模式（`html.is-section-shot .app-shell > *`）靠这层关系隐藏同级板块，中间插
 *    wrapper 或返回兄弟节点都会让钩子失效。
 * ② 文案、地址、图片路径全部来自 `content/about.ts`，这里只负责把 DOM 拼出来。
 *
 * 样式在 `pages/about.css`（自带前缀 `.about__*`，不往 `styles.css` 里塞）。
 */

import {
  ABOUT_CONTACTS,
  ABOUT_CONTACT_NOTE,
  ABOUT_CONTACT_TITLE,
  ABOUT_EMAIL,
  ABOUT_KICKER,
  ABOUT_LEDE,
  ABOUT_PARAGRAPHS,
  ABOUT_PORTRAIT,
  ABOUT_SPONSOR_NOTE,
  ABOUT_SPONSOR_TITLE,
  ABOUT_SPONSORS,
  ABOUT_TITLE,
  ABOUT_TITLE_SUFFIX,
} from '../content/about';
import type { RouteView } from '../router';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 页头左栏：相框 + 图注。 */
function buildPortrait(): HTMLElement {
  const figure = el('figure', 'about__portrait');

  const frame = el('div', 'about__frame');
  const photo = el('img', 'about__photo');
  // 路径前缀与宽度档是配套的，拼在一处才不会漏改其中一半。
  photo.srcset = ABOUT_PORTRAIT.widths
    .map((width) => `${ABOUT_PORTRAIT.base}-${width}.png ${width}w`)
    .join(', ');
  const largest = ABOUT_PORTRAIT.widths[ABOUT_PORTRAIT.widths.length - 1];
  photo.src = `${ABOUT_PORTRAIT.base}-${largest}.png`;
  // `sizes` 不能省：否则浏览器按 100vw 挑图，小屏也会下 1024 那档。
  photo.sizes = ABOUT_PORTRAIT.sizes;
  photo.alt = ABOUT_PORTRAIT.alt;
  photo.decoding = 'async';
  photo.draggable = false;
  frame.append(photo);

  figure.append(frame, el('figcaption', 'about__caption', ABOUT_PORTRAIT.caption));
  return figure;
}

/** 一条「联系我」胶囊。 */
function buildContactLink(contact: (typeof ABOUT_CONTACTS)[number]): HTMLElement {
  const item = el('li');
  const link = el('a', 'about__pill');
  link.href = contact.href;
  link.title = contact.hint;

  if (contact.external) {
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
  }

  // 徽标只是视觉锚点，读屏念出孤零零一个「Q」没有意义，直接屏蔽。
  const badge = el('span', 'about__pill-badge', contact.glyph);
  badge.setAttribute('aria-hidden', 'true');

  link.append(badge, el('span', 'about__pill-label', contact.label));
  if (contact.external) {
    // 新窗口打开这件事，鼠标用户看箭头就知道，键盘/读屏用户得听得到。
    link.append(el('span', 'about__sr-only', '（在新标签页打开）'));
  }

  item.append(link);
  return item;
}

/**
 * 一颗「赞助」胶囊 + 它上方的收款码浮层。
 *
 * 用 `<button>` 而不是 `<a>`：这里没有跳转目标，但它**必须能被 Tab 聚焦**——
 * 浮层靠 `:hover` / `:focus-within` 两种状态显形（纯 CSS，不写 JS 开关），
 * 键盘用户 Tab 过来、触屏用户点一下（拿到焦点）都能看到二维码。
 *
 * 二维码在这颗胶囊的**上方**弹出：关于页后面没有别的区块，往下弹会被页面底边裁掉。
 * 图片尺寸写死在属性上（220×220），浮层出现时不会因为解码而先撑成 0 高再跳一下。
 */
function buildSponsorItem(sponsor: (typeof ABOUT_SPONSORS)[number]): HTMLElement {
  const item = el('li');
  const wrap = el('div', `sponsor sponsor--${sponsor.id}`);

  const button = el('button', 'sponsor__pill');
  button.type = 'button';
  button.title = sponsor.hint;

  // 徽标只是视觉锚点：读屏念出孤零零一个「支」没有意义，直接屏蔽。
  const mark = el('span', 'sponsor__mark', sponsor.glyph);
  mark.setAttribute('aria-hidden', 'true');

  button.append(mark, el('span', 'sponsor__label', sponsor.label));

  const popover = el('span', 'sponsor__qr');
  popover.setAttribute('aria-hidden', 'true');
  const image = el('img', 'sponsor__qr-image');
  image.src = sponsor.qr;
  image.alt = `${sponsor.label}收款二维码`;
  image.width = 220;
  image.height = 220;
  // 浮层默认 `visibility: hidden`，lazy 会让它悬停时才去解码 —— 那一下正好卡在手感上。
  image.decoding = 'async';
  image.draggable = false;
  popover.append(image);

  wrap.append(button, popover);
  item.append(wrap);
  return item;
}

/** 赞助我：一句邀请 + 两枚实心品牌色胶囊（支付宝蓝 / 微信绿），悬停或聚焦出码。 */
function buildSponsor(): HTMLElement {
  const section = el('section', 'about__block about__sponsor');
  section.setAttribute('aria-labelledby', 'about-sponsor-title');

  const title = el('h2', 'about__section-title', ABOUT_SPONSOR_TITLE);
  title.id = 'about-sponsor-title';

  const links = el('ul', 'about__links');
  links.append(...ABOUT_SPONSORS.map(buildSponsorItem));

  section.append(title, el('p', 'about__section-note', ABOUT_SPONSOR_NOTE), links);
  return section;
}

export function createAboutPage(): RouteView {
  const baseTitle = document.title;

  const section = el('section', 'about');
  section.setAttribute('aria-labelledby', 'about-title');

  const inner = el('div', 'about__inner');

  /* 页头：左头像 + 右标题/引子 ------------------------------------------- */
  const head = el('header', 'about__head');
  const intro = el('div', 'about__intro');
  const title = el('h1', 'about__title', ABOUT_TITLE);
  title.id = 'about-title';
  intro.append(el('p', 'about__kicker', ABOUT_KICKER), title, el('p', 'about__lede', ABOUT_LEDE));
  head.append(buildPortrait(), intro);

  /* 正文 ---------------------------------------------------------------- */
  const body = el('article', 'about__block about__body');
  for (const paragraph of ABOUT_PARAGRAPHS) {
    body.append(el('p', 'about__para', paragraph));
  }

  /* 联系我 -------------------------------------------------------------- */
  const contact = el('section', 'about__block about__contact');
  contact.setAttribute('aria-labelledby', 'about-contact-title');
  const contactTitle = el('h2', 'about__section-title', ABOUT_CONTACT_TITLE);
  contactTitle.id = 'about-contact-title';

  const links = el('ul', 'about__links');
  links.append(...ABOUT_CONTACTS.map(buildContactLink));

  // 邮箱地址很长，胶囊里只放短标签，全址单独一行（可选中复制、可读屏）。
  const mail = el('p', 'about__mail');
  const mailLink = el('a', 'about__mail-link', ABOUT_EMAIL);
  mailLink.href = `mailto:${ABOUT_EMAIL}`;
  mail.append(mailLink);

  contact.append(
    contactTitle,
    el('p', 'about__section-note', ABOUT_CONTACT_NOTE),
    links,
    mail,
  );

  /* 赞助我 -------------------------------------------------------------- */
  // 放在「联系我」之后：先给读者联系方式，再谈打赏；顺序反过来像在要钱。
  inner.append(head, body, contact, buildSponsor());
  section.append(inner);

  document.title = `${ABOUT_TITLE}${ABOUT_TITLE_SUFFIX}`;

  return {
    elements: [section],
    // 路由是先 dispose 再摘节点，所以这里还原标题一定早于下一个视图读 baseTitle。
    dispose: () => {
      document.title = baseTitle;
    },
  };
}
