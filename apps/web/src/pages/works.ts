/**
 * 「作品」标签页——真实的作品列表。
 *
 * 版式参考 GitHub 的仓库页：上方是标题 + 统计 + 搜索 / 分类筛选，下面是内容网格。
 * 但每张卡带一张 16:9 的封面——这是本站与 GitHub 最大的不同：**先看长得什么样，再决定
 * 要不要点进去**。封面读的是作品缩略图（后台可上传），没有图就退化成由 slug 派生的
 * 纯色块 + 首字，绝不会出现破图。
 *
 * 数据来自公开接口 `/api/works`（只返回已发布的）。三种状态都要能看：
 *   loading（骨架）/ ready（网格或空态）/ error（一句人话 + 重试）。
 */

import type { RouteView } from '../router';
import { fetchWorks, workHref, type WorkSummary } from '../works/api';
import { coverHue } from '../works/present';

interface ListState {
  works: WorkSummary[];
  query: string;
  /** 空串 = 全部。 */
  category: string;
  status: 'loading' | 'ready' | 'error';
  message: string;
}

export function createWorksPage(): RouteView {
  const state: ListState = { works: [], query: '', category: '', status: 'loading', message: '' };

  let closed = false;
  const abort = new AbortController();

  /* —— 骨架 —— */
  const section = document.createElement('section');
  section.className = 'works-index';

  const inner = document.createElement('div');
  inner.className = 'wk-inner';

  const kicker = document.createElement('p');
  kicker.className = 'wk-kicker';
  kicker.textContent = 'WORKS';

  const title = document.createElement('h1');
  title.className = 'wk-title';
  title.textContent = '作品';

  const stats = document.createElement('p');
  stats.className = 'wk-stats';
  stats.textContent = '正在读取…';

  const headLead = document.createElement('div');
  headLead.className = 'wk-head__lead';
  headLead.append(kicker, title, stats);

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'wk-search__input';
  searchInput.placeholder = '搜索标题、简介或技术栈';
  searchInput.setAttribute('aria-label', '搜索作品');
  searchInput.autocomplete = 'off';

  const search = document.createElement('label');
  search.className = 'wk-search';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'wk-search__icon';
  searchIcon.textContent = '⌕';
  searchIcon.setAttribute('aria-hidden', 'true');
  search.append(searchIcon, searchInput);

  const chips = document.createElement('div');
  chips.className = 'wk-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', '按分类筛选');

  const tools = document.createElement('div');
  tools.className = 'wk-tools';
  tools.append(search, chips);

  const head = document.createElement('header');
  head.className = 'wk-head';
  head.append(headLead, tools);

  const grid = document.createElement('div');
  grid.className = 'wk-grid';

  const stateLine = document.createElement('p');
  stateLine.className = 'wk-state';
  stateLine.setAttribute('role', 'status');
  stateLine.setAttribute('aria-live', 'polite');

  inner.append(head, stateLine, grid);
  section.append(inner);

  /* —— 派生数据 —— */
  const categories = (): string[] => {
    const seen = new Set<string>();
    for (const work of state.works) if (work.category) seen.add(work.category);
    // 中文分类按拼音排，英文按字母，混在一起时也不至于每次刷新都换顺序。
    return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  };

  const visibleWorks = (): WorkSummary[] => {
    const query = state.query.trim().toLowerCase();
    return state.works.filter((work) => {
      if (state.category && work.category !== state.category) return false;
      if (!query) return true;
      const haystack = [work.title, work.summary, work.slug, work.category, ...work.tags]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  };

  /* —— 卡片 —— */
  const createCard = (work: WorkSummary): HTMLElement => {
    const card = document.createElement('a');
    card.className = 'wk-card';
    card.href = workHref(work.slug);

    const cover = document.createElement('div');
    cover.className = 'wk-card__cover';
    if (work.thumbnail) {
      const img = document.createElement('img');
      img.src = work.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      cover.append(img);
    } else {
      // 没有封面的作品照样要有辨识度：色相由 slug 决定，改标题不会让颜色乱跳。
      cover.classList.add('is-placeholder');
      cover.style.setProperty('--cover-hue', String(coverHue(work.slug)));
      const glyph = document.createElement('span');
      glyph.className = 'wk-card__glyph';
      glyph.textContent = work.title.trim().slice(0, 1) || '作';
      cover.append(glyph);
    }

    // 开发者模式（整页自定义）给个角标：列表里唯一看不出来的差别就是它。
    if (work.mode === 'developer') {
      const modeBadge = document.createElement('span');
      modeBadge.className = 'wk-card__mode';
      modeBadge.textContent = '自定义';
      cover.append(modeBadge);
    }

    const body = document.createElement('div');
    body.className = 'wk-card__body';

    const cardTitle = document.createElement('h2');
    cardTitle.className = 'wk-card__title';
    cardTitle.textContent = work.title;

    body.append(cardTitle);

    if (work.summary) {
      const summary = document.createElement('p');
      summary.className = 'wk-card__summary';
      summary.textContent = work.summary;
      body.append(summary);
    }

    const meta = document.createElement('div');
    meta.className = 'wk-card__meta';

    if (work.year) {
      const year = document.createElement('span');
      year.className = 'wk-card__year';
      year.textContent = work.year;
      meta.append(year);
    }

    if (work.category) {
      const category = document.createElement('span');
      category.className = 'wk-card__category';
      category.textContent = work.category;
      meta.append(category);
    }

    const tags = document.createElement('ul');
    tags.className = 'wk-card__tags';
    for (const tag of work.tags.slice(0, 4)) {
      const item = document.createElement('li');
      item.className = 'wk-card__tag';
      item.textContent = tag;
      tags.append(item);
    }

    if (tags.childElementCount > 0) meta.append(tags);
    if (meta.childElementCount > 0) body.append(meta);

    card.append(cover, body);
    return card;
  };

  /* —— 渲染 —— */
  const renderChips = (): void => {
    chips.replaceChildren();
    const options = ['', ...categories()];
    if (options.length <= 2) {
      // 只有一个分类（或没有分类）时不显示筛选条，省得占一行却没有可选项。
      chips.hidden = true;
      return;
    }
    chips.hidden = false;
    for (const option of options) {
      const active = state.category === option;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wk-chip${active ? ' is-active' : ''}`;
      button.textContent = option || '全部';
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => {
        state.category = option;
        renderChips();
        renderGrid();
      });
      chips.append(button);
    }
  };

  const renderStats = (shown: number): void => {
    if (state.status === 'loading') {
      stats.textContent = '正在读取…';
      return;
    }
    if (state.status === 'error') {
      stats.textContent = '读取失败';
      return;
    }
    const total = state.works.length;
    const categoryCount = categories().length;
    const parts = [`共 ${total} 个作品`];
    if (categoryCount > 0) parts.push(`${categoryCount} 个分类`);
    if (shown !== total) parts.push(`当前筛出 ${shown} 个`);
    stats.textContent = parts.join(' · ');
  };

  const renderGrid = (): void => {
    const shown = visibleWorks();

    if (state.status === 'loading') {
      grid.replaceChildren();
      stateLine.hidden = false;
      stateLine.className = 'wk-state';
      stateLine.textContent = '正在读取作品…';
      renderStats(0);
      return;
    }

    if (state.status === 'error') {
      grid.replaceChildren();
      stateLine.hidden = false;
      stateLine.className = 'wk-state is-error';
      stateLine.replaceChildren();
      const message = document.createElement('span');
      message.textContent = state.message || '读取作品失败。';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'wk-retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => void load());
      stateLine.append(message, retry);
      renderStats(0);
      return;
    }

    grid.replaceChildren(...shown.map(createCard));

    if (shown.length === 0) {
      stateLine.hidden = false;
      stateLine.className = 'wk-state';
      stateLine.textContent =
        state.works.length === 0
          ? '作品还在整理中，先逛逛首页那段滚动作品墙。'
          : '没有匹配的作品，换个关键词或分类试试。';
    } else {
      stateLine.hidden = true;
      stateLine.replaceChildren();
    }

    renderStats(shown.length);
  };

  /* —— 交互 —— */
  // 只重画网格：搜索框是常驻节点，重画它会让光标每敲一个字就丢一次。
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    renderGrid();
  });

  /* —— 加载 —— */
  async function load(): Promise<void> {
    state.status = 'loading';
    renderGrid();
    renderChips();

    const result = await fetchWorks(abort.signal);
    // 视图可能已经被路由拆掉了：此时任何 DOM 操作都写在废弃节点上，白费力气。
    if (closed) return;

    if (result.error) {
      state.status = 'error';
      state.message = result.error;
    } else {
      state.works = result.works;
      state.status = 'ready';
      state.message = '';
      // 之前选中的分类可能已经不存在了（作品被删），回落到「全部」。
      if (state.category && !categories().includes(state.category)) state.category = '';
    }

    renderChips();
    renderGrid();
  }

  void load();

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      abort.abort();
    },
  };
}
