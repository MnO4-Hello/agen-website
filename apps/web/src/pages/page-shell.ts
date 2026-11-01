/**
 * 占位页的通用外壳。
 *
 * 五个标签页里现在只剩「关于我」还是骨架（作品 / 博客 / 留言都接管成真实模块了），
 * 这套「标题 + 一句说明 + 回主页」的最小结构就只服务那一页：等它要写内容时，把
 * `pages/about.ts` 换成自己的布局即可，不必再动这里。
 *
 * 结构刻意压到一节一带 `.page__inner`：`min-height: 100lvh` + 居中，让「页面已经存在」
 * 这件事一眼看得出来，而不是一屏空白（顶栏是 sticky 的，空白页会像加载失败）。
 */

import { PAGE_BACK_LABEL, PAGE_BADGE, PAGE_COPY, type PlaceholderPageId } from '../content/pages';
import type { RouteView } from '../router';

export function createPlaceholderPage(id: PlaceholderPageId): RouteView {
  const copy = PAGE_COPY[id];

  const section = document.createElement('section');
  // `page--<id>` 留给以后按页面覆盖样式用（也方便在控制台里一眼看出当前是哪页）。
  section.className = `page page--${id}`;

  const inner = document.createElement('div');
  inner.className = 'page__inner';

  const badge = document.createElement('span');
  badge.className = 'page__badge';
  badge.textContent = PAGE_BADGE;

  const title = document.createElement('h1');
  title.className = 'page__title';
  title.textContent = copy.title;

  const note = document.createElement('p');
  note.className = 'page__note';
  note.textContent = copy.note;

  // 普通哈希链接就够了：点它浏览器改哈希 → 路由的 hashchange 挂回主页视图。
  // 不拦点击，浏览器原生行为（中键新标签、右键复制链接）都还能用。
  const back = document.createElement('a');
  back.className = 'page__back';
  back.href = '#home';
  back.textContent = PAGE_BACK_LABEL;

  inner.append(badge, title, note, back);
  section.append(inner);

  return {
    elements: [section],
    // 占位页只有静态节点：没有监听、计时器、画布要收，DOM 由路由统一摘掉。
    dispose: () => {},
  };
}
