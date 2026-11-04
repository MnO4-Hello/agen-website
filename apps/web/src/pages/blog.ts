/**
 * 「博客」列表页（`#blog`）。
 *
 * 结构照着 `pages/works.ts`：三态（loading / ready / error）+ 常驻搜索框 + 分类 chips +
 * 底部追加。几个必须照抄的纪律：
 *
 *   1. **只重画列表与状态行，绝不 `replaceChildren` 搜索框**。搜索框一被重建，光标就
 *      丢了，用户每敲一个字都要重新点一次。
 *   2. **搜索 300ms 防抖**。服务端搜索是 O(n) 全量扫描（`blog.json` 一次读进内存），
 *      每敲一键就发一次请求会把串行队列压住，反而更卡。
 *   3. **筛选变更要 `reqId + 1`**。旧请求回来晚了一步就丢掉，否则「先搜 A 再搜 B，
 *      A 的结果后到」会把 B 的列表盖掉。
 *   4. **筛选态不进地址栏**。`router.ts` 的 `matchRoute()` 会把 `#blog?...` 的 query
 *      整个丢掉，而且每次 `hashchange` 都会销毁重建视图——搜索框每敲一个字就重建
 *      一次 DOM。所以状态只放内存，另存一份到 sessionStorage，让「点进帖子再返回」
 *      不丢筛选。
 */

import { BLOG_COPY } from '../content/blog';
import { fetchCategories, fetchPosts, fetchTags, postHref, votePost } from '../blog/api';
import { formatCount, formatRelative } from '../blog/present';
import type { CategoryView, PostSort, PostSummary, TagView, VoteValue } from '../blog/types';
import { getAuthState, rememberReturnTo } from '../auth/session';
import type { RouteView } from '../router';
import { createMediaImage, photoLink } from '../shared/media';

const PAGE_SIZE = 10;
const STORAGE_KEY = 'blog:list:v1';
const SEARCH_DEBOUNCE_MS = 300;

interface Filters {
  q: string;
  categoryId: string;
  tag: string;
  sort: PostSort;
}

interface ListState extends Filters {
  items: PostSummary[];
  cursor: string | null;
  total: number;
  status: 'loading' | 'ready' | 'error';
  more: 'idle' | 'loading' | 'error';
  message: string;
  /** 每次「换筛选条件」自增；旧请求回来时对不上就丢弃。 */
  reqId: number;
}

/** 只存筛选条件。**不存 items / cursor**：数据一变，半截列表必然重复或断层。 */
function readFilters(): Filters {
  const fallback: Filters = { q: '', categoryId: '', tag: '', sort: 'new' };
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<Record<keyof Filters, unknown>>;
    return {
      q: typeof value.q === 'string' ? value.q : '',
      categoryId: typeof value.categoryId === 'string' ? value.categoryId : '',
      tag: typeof value.tag === 'string' ? value.tag : '',
      sort: value.sort === 'hot' ? 'hot' : 'new',
    };
  } catch {
    return fallback;
  }
}

function writeFilters(filters: Filters): void {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        q: filters.q,
        categoryId: filters.categoryId,
        tag: filters.tag,
        sort: filters.sort,
      }),
    );
  } catch {
    // 隐私模式下 sessionStorage 可能直接抛错——筛选不记住而已，不影响使用。
  }
}

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

export function createBlogPage(): RouteView {
  const saved = readFilters();
  const state: ListState = {
    ...saved,
    items: [],
    cursor: null,
    total: 0,
    status: 'loading',
    more: 'idle',
    message: '',
    reqId: 0,
  };

  let closed = false;
  let categories: CategoryView[] = [];
  let tags: TagView[] = [];
  const abort = new AbortController();
  let debounce = 0;

  /* 骨架 ---------------------------------------------------------------- */
  const section = el('section', 'blog-index');
  const inner = el('div', 'bl-inner');

  const head = el('header', 'bl-head');
  const lead = el('div', 'bl-head__lead');
  lead.append(
    el('p', 'bl-kicker', BLOG_COPY.kicker),
    el('h1', 'bl-title', BLOG_COPY.title),
    el('p', 'bl-intro', BLOG_COPY.intro),
  );
  const stats = el('p', 'bl-stats');
  lead.append(stats);

  const tools = el('div', 'bl-tools');
  const search = el('label', 'bl-search');
  search.append(el('span', 'bl-search__icon', '⌕'));
  const searchInput = el('input', 'bl-search__input');
  searchInput.type = 'search';
  searchInput.placeholder = BLOG_COPY.searchPlaceholder;
  searchInput.value = state.q;
  searchInput.setAttribute('aria-label', BLOG_COPY.searchLabel);
  search.append(searchInput);

  const sortGroup = el('div', 'bl-sort');
  sortGroup.setAttribute('role', 'group');
  sortGroup.setAttribute('aria-label', '排序方式');
  const sortButtons: Array<{ sort: PostSort; button: HTMLButtonElement }> = [];
  for (const [sort, label] of [
    ['new', BLOG_COPY.sortNew],
    ['hot', BLOG_COPY.sortHot],
  ] as const) {
    const button = el('button', 'bl-sort__item', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (state.sort === sort) return;
      state.sort = sort;
      commitFilters();
    });
    sortButtons.push({ sort, button });
    sortGroup.append(button);
  }

  tools.append(search, sortGroup);
  head.append(lead, tools);

  const cats = el('nav', 'bl-cats');
  cats.setAttribute('aria-label', '按分类筛选');

  const tagRow = el('div', 'bl-tags');
  tagRow.setAttribute('aria-label', '按标签筛选');

  const stateLine = el('p', 'bl-state');
  stateLine.setAttribute('role', 'status');
  stateLine.setAttribute('aria-live', 'polite');

  const list = el('ol', 'bl-list');

  const moreWrap = el('div', 'bl-more');
  const moreButton = el('button', 'bl-btn bl-btn--ghost bl-more__btn', BLOG_COPY.loadMore);
  moreButton.type = 'button';
  moreButton.addEventListener('click', () => {
    if (state.more === 'loading' || state.status !== 'ready' || !state.cursor) return;
    void loadPosts(false);
  });
  moreWrap.append(moreButton);

  inner.append(head, cats, tagRow, stateLine, list, moreWrap);
  section.append(inner);

  /* 渲染 ---------------------------------------------------------------- */

  function renderStats(): void {
    const parts = [`共 ${formatCount(state.total)} 篇`];
    if (categories.length > 1) parts.push(`${categories.length} 个分类`);
    const filtering = Boolean(state.q || state.categoryId || state.tag);
    if (filtering && state.status === 'ready') parts.push(`当前筛出 ${state.total} 篇`);
    stats.textContent = parts.join(' · ');
  }

  function renderSort(): void {
    for (const { sort, button } of sortButtons) {
      const active = state.sort === sort;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function renderChips(): void {
    const all = el('button', 'bl-chip', BLOG_COPY.allCategories);
    all.type = 'button';
    all.classList.toggle('is-active', !state.categoryId);
    all.setAttribute('aria-pressed', !state.categoryId ? 'true' : 'false');
    all.addEventListener('click', () => {
      if (!state.categoryId) return;
      state.categoryId = '';
      commitFilters();
    });

    const buttons: HTMLElement[] = [all];
    for (const category of categories) {
      const button = el('button', 'bl-chip', category.name);
      button.type = 'button';
      const active = state.categoryId === category.id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.title = `${category.count} 篇`;
      button.addEventListener('click', () => {
        if (state.categoryId === category.id) return;
        state.categoryId = category.id;
        commitFilters();
      });
      buttons.push(button);
    }
    cats.replaceChildren(...buttons);
    cats.hidden = categories.length <= 1;
  }

  function renderTagRow(): void {
    tagRow.replaceChildren();
    if (tags.length === 0) {
      tagRow.hidden = true;
      return;
    }
    tagRow.hidden = false;

    if (state.tag) {
      const active = tags.find((tag) => tag.key === state.tag);
      const clear = el('button', 'bl-tag is-active', `#${active?.label ?? state.tag} ×`);
      clear.type = 'button';
      clear.title = BLOG_COPY.clearTag;
      clear.addEventListener('click', () => {
        state.tag = '';
        commitFilters();
      });
      tagRow.append(clear);
      return;
    }

    for (const tag of tags.slice(0, 12)) {
      const button = el('button', 'bl-tag', `#${tag.label}`);
      button.type = 'button';
      button.title = `${tag.count} 篇`;
      button.addEventListener('click', () => {
        state.tag = tag.key;
        commitFilters();
      });
      tagRow.append(button);
    }
  }

  /**
   * 列表里的赞同胶囊。
   *
   * 与详情页的 rail 投票同一套语义（见 `pages/blog-post.ts` 的 `handlePostVote`）：
   * 未登录先送登录页，登录后乐观更新、失败回滚。区别只在于这里改的是列表自己的
   * `post` 对象——它同时也是重新渲染列表时的数据源，所以不会出现「投完又被旧值盖回」。
   */
  async function castVote(
    post: PostSummary,
    pill: HTMLButtonElement,
    count: HTMLElement,
  ): Promise<void> {
    if (getAuthState().status !== 'user') {
      // 登录成功后 `takeReturnTo()` 会把人送回博客列表。
      rememberReturnTo('#blog');
      window.location.hash = '#login';
      return;
    }
    if (pill.classList.contains('is-busy')) return;

    const previous = { score: post.score, up: post.up, down: post.down, myVote: post.myVote };
    const next: VoteValue = previous.myVote === 1 ? 0 : 1;

    const paint = (): void => {
      count.textContent = formatCount(post.score);
      pill.title = `${BLOG_COPY.voteUp} ${post.score}`;
      pill.setAttribute('aria-pressed', post.myVote === 1 ? 'true' : 'false');
    };

    // 乐观更新：等待 200ms 才变化的数字会让人以为没点中。列表里只做「赞同 / 取消赞」，
    // 没有「踩」——取消时把原来那票退回去。
    let { up, down } = previous;
    if (previous.myVote === 1) up -= 1;
    if (previous.myVote === -1) down -= 1;
    if (next === 1) up += 1;
    up = Math.max(0, up);
    down = Math.max(0, down);
    post.up = up;
    post.down = down;
    post.score = up - down;
    post.myVote = next;
    paint();
    pill.classList.add('is-busy');

    const result = await votePost(post.slug, next, abort.signal);
    if (closed) return;

    pill.classList.remove('is-busy');
    if (result.ok) {
      post.up = result.data.up;
      post.down = result.data.down;
      post.score = result.data.score;
      post.myVote = result.data.myVote;
      paint();
      return;
    }

    post.score = previous.score;
    post.up = previous.up;
    post.down = previous.down;
    post.myVote = previous.myVote;
    paint();
    pill.classList.add('is-error');
    pill.title = result.message || BLOG_COPY.voteFailed;
    window.setTimeout(() => pill.classList.remove('is-error'), 1600);
  }

  function createCard(post: PostSummary): HTMLElement {
    const item = el('li');
    const card = el('article', 'bl-card');

    const main = el('div', 'bl-card__main');
    const title = el('h2', 'bl-card__title');
    const link = el('a', undefined, post.title);
    link.href = postHref(post.slug);
    title.append(link);

    const excerpt = el('p', 'bl-card__excerpt', post.excerpt || '（暂无摘要）');

    const meta = el('div', 'bl-card__meta');
    meta.append(el('span', 'bl-card__author', post.author.nickname));
    if (post.author.owner) meta.append(el('span', 'bp-badge bp-badge--owner', '站长'));
    meta.append(el('span', 'bl-dot'), el('span', undefined, formatRelative(post.createdAt)));

    if (post.category) {
      const cat = el('button', 'bl-card__cat', post.category.name);
      cat.type = 'button';
      cat.addEventListener('click', () => {
        if (state.categoryId === post.category?.id) return;
        state.categoryId = post.category?.id ?? '';
        commitFilters();
      });
      meta.append(cat);
    }

    if (post.tags.length > 0) {
      const tagWrap = el('span', 'bl-card__tags');
      for (const label of post.tags) {
        const tagButton = el('button', 'bl-card__tag', `#${label}`);
        tagButton.type = 'button';
        // 点标签等价于搜这个标签：不额外维护一套 tag 索引，行为也符合直觉。
        tagButton.addEventListener('click', () => {
          searchInput.value = label;
          state.q = label;
          state.tag = '';
          commitFilters();
        });
        tagWrap.append(tagButton);
      }
      meta.append(tagWrap);
    }

    meta.append(
      el('span', 'bl-dot'),
      el('span', undefined, `${formatCount(post.replyCount)} 条回复`),
    );

    /* 赞同胶囊：原来左侧那一整列色块太占地方，收到小字行的末尾。
       小字本身是 `.78rem` 的灰色文字，胶囊用同一行的尺寸，读起来是一句
       「… · 12 条回复 · ▲3」，而不是一个突兀的控件。 */
    const pill = el('button', 'bl-card__vote-pill');
    pill.type = 'button';
    const count = el('span', 'bl-card__vote-num', formatCount(post.score));
    pill.append(el('span', 'bl-card__vote-glyph', '▲'), count);
    pill.title = `${BLOG_COPY.voteUp} ${post.score}`;
    pill.setAttribute('aria-pressed', post.myVote === 1 ? 'true' : 'false');
    pill.addEventListener('click', () => void castVote(post, pill, count));
    meta.append(el('span', 'bl-dot'), pill);

    main.append(title, excerpt, meta);

    // 有封面才在最左侧插一个正方形小窗口；没有就保持原来的整行排版。
    if (post.coverImage) {
      card.classList.add('bl-card--cover');
      /*
       * 卡片本身是 `<article>`（只有标题是链接），所以封面可以再包一层 `<a>` 而不产生
       * 嵌套锚点。窗口只有 4.5rem 见方，用 `thumb` 那档（长边 512）已经绰绰有余。
       */
      const img = createMediaImage({ src: post.coverImage, tier: 'thumb' });
      card.append(photoLink(post.coverImage, img, 'bl-card__cover'), main);
    } else {
      card.append(main);
    }
    item.append(card);
    return item;
  }

  function renderList(): void {
    renderStats();
    renderSort();
    renderChips();
    renderTagRow();

    if (state.status === 'loading') {
      list.replaceChildren();
      stateLine.hidden = false;
      stateLine.classList.remove('is-error');
      stateLine.textContent = BLOG_COPY.loading;
      moreWrap.hidden = true;
      return;
    }

    if (state.status === 'error') {
      list.replaceChildren();
      stateLine.hidden = false;
      stateLine.classList.add('is-error');
      stateLine.replaceChildren();
      stateLine.append(el('span', undefined, state.message || BLOG_COPY.error));
      const retry = el('button', 'bl-retry', BLOG_COPY.retry);
      retry.type = 'button';
      retry.addEventListener('click', () => void loadPosts(true));
      stateLine.append(retry);
      moreWrap.hidden = true;
      return;
    }

    list.replaceChildren(...state.items.map(createCard));

    if (state.items.length === 0) {
      stateLine.hidden = false;
      stateLine.classList.remove('is-error');
      const filtering = Boolean(state.q || state.categoryId || state.tag);
      stateLine.textContent = filtering ? BLOG_COPY.emptyFiltered : BLOG_COPY.emptyLibrary;
      moreWrap.hidden = true;
      return;
    }

    stateLine.hidden = true;
    stateLine.replaceChildren();

    moreWrap.hidden = !state.cursor;
    moreButton.disabled = state.more === 'loading';
    moreButton.textContent =
      state.more === 'loading'
        ? BLOG_COPY.loadMoreLoading
        : state.more === 'error'
          ? BLOG_COPY.loadMoreError
          : BLOG_COPY.loadMore;
  }

  /* 数据 ---------------------------------------------------------------- */

  async function loadPosts(reset: boolean): Promise<void> {
    const reqId = (state.reqId += 1);
    if (reset) {
      state.status = 'loading';
      state.items = [];
      state.cursor = null;
      state.message = '';
      state.more = 'idle';
    } else {
      state.more = 'loading';
    }
    renderList();

    const result = await fetchPosts(
      {
        q: state.q,
        categoryId: state.categoryId,
        tag: state.tag,
        sort: state.sort,
        cursor: reset ? '' : (state.cursor ?? ''),
        limit: PAGE_SIZE,
      },
      abort.signal,
    );

    // 视图已经被拆掉，或者这次请求已经不是最新的那次。
    if (closed || reqId !== state.reqId) return;

    if (!result.ok) {
      if (!result.message) return; // 被主动取消
      if (reset) {
        state.status = 'error';
        state.message = result.message;
      } else {
        state.more = 'error';
      }
      renderList();
      return;
    }

    const incoming = result.data.posts;
    if (reset) {
      state.items = incoming;
    } else {
      // 热度排序在翻页期间可能因为投票而漂移，按 id 去重一次，避免同一条出现两遍。
      const seen = new Set(state.items.map((post) => post.id));
      state.items = [...state.items, ...incoming.filter((post) => !seen.has(post.id))];
    }

    state.cursor = result.data.nextCursor;
    state.total = result.data.total;
    state.status = 'ready';
    state.more = 'idle';
    renderList();
  }

  async function loadFacets(): Promise<void> {
    const [catResult, tagResult] = await Promise.all([
      fetchCategories(abort.signal),
      fetchTags(12, abort.signal),
    ]);
    if (closed) return;

    if (catResult.ok) {
      categories = catResult.data;
      // 分类被删掉之后，sessionStorage 里恢复出来的是个死 id——静默回落「全部」。
      if (state.categoryId && !categories.some((category) => category.id === state.categoryId)) {
        state.categoryId = '';
        writeFilters(state);
      }
    }
    if (tagResult.ok) {
      tags = tagResult.data;
      if (state.tag && !tags.some((tag) => tag.key === state.tag)) state.tag = '';
    }
    renderList();
  }

  /** 筛选变更的唯一出口：写回存储 → 重置列表 → 重新拉第一页。 */
  function commitFilters(): void {
    writeFilters(state);
    void loadPosts(true);
  }

  searchInput.addEventListener('input', () => {
    const value = searchInput.value;
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = 0;
      const next = value.trim();
      if (next === state.q) return;
      state.q = next;
      commitFilters();
    }, SEARCH_DEBOUNCE_MS);
  });

  void loadFacets();
  void loadPosts(true);

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      abort.abort();
      if (debounce) window.clearTimeout(debounce);
    },
  };
}
