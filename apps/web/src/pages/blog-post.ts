/**
 * 帖子详情页（`#blog/<slug>`）。
 *
 * 四态（loading / ok / missing / error）与工作详情页同构：**同步建壳、异步填数据**，
 * 因为 `router.start()` 必须同步产生首帧。
 *
 * 三个容易写漏的点，都在下面标了原因：
 *
 *   1. **必须 `subscribe(getAuthState)` 并在 dispose 里取消订阅**。首帧时
 *      `getAuthState()` 常常还是 `unknown`（会话还没问回来），不订阅就永远按游客渲染，
 *      验证码框会一直挂在那儿。
 *   2. **`document.title` 要改也要还原**，否则从帖子页回到列表，标签页还挂着上一篇的标题。
 *   3. **发完回复后按 id 去重追加**。楼层号由服务端分配，本地既不能算也不能假设连续
 *      （中间可能有你还没加载的楼层）。
 */

import type { AppRoute } from '../app-routes';
import { getAuthState, rememberReturnTo, subscribe } from '../auth/session';
import { fetchCaptcha, fetchPost, fetchReplies, postReply, votePost, voteReply } from '../blog/api';
import { createBlogAvatar } from '../blog/avatar';
import { createFloor, type FloorHandle } from '../blog/floor';
import { formatDateTime, publishTimeOf } from '../blog/present';
import { createReplyForm } from '../blog/reply-form';
import { createVoteBar } from '../blog/vote';
import type { PostDetail, ReplyView, VoteValue } from '../blog/types';
import { BLOG_COPY, BLOG_TITLE_SUFFIX } from '../content/blog';
import { renderMarkdown } from '../shared/markdown';
import type { RouteView } from '../router';

export interface BlogPostPageOptions {
  /** 地址栏第二段（`#blog/<slug>` 的 slug）。 */
  readonly slug: string;
  readonly navigate: (route: AppRoute, param?: string | null) => void;
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

export function createBlogPostPage(options: BlogPostPageOptions): RouteView {
  const section = el('section', 'blog-post');
  const inner = el('div', 'bp-inner');
  const crumb = el('nav', 'bp-crumb');
  const stage = el('div', 'bp-stage');
  inner.append(crumb, stage);
  section.append(inner);

  let closed = false;
  let replies: ReplyView[] = [];
  let replyCursor: string | null = null;
  const abort = new AbortController();
  const baseTitle = document.title;
  let unsubscribe: (() => void) | null = null;

  const floors = new Map<string, FloorHandle>();

  /* 提示态 -------------------------------------------------------------- */

  function showNotice(kind: 'loading' | 'missing' | 'error', message: string): void {
    // 打在 `data-state` 上：截图脚本与回归测试靠它判断当前落在哪一态。
    section.dataset.state = kind;
    crumb.replaceChildren();
    const link = el('a', undefined, '社区');
    link.href = '#blog';
    crumb.append(link);

    const notice = el('div', `bp-notice${kind === 'error' ? ' is-error' : ''}`);
    notice.append(el('h1', 'bp-notice__title', kind === 'loading' ? '正在读取帖子…' : ''));
    if (kind !== 'loading') notice.append(el('p', undefined, message));

    if (kind === 'missing') {
      const back = el('a', 'bl-btn bl-btn--ghost', BLOG_COPY.backToList);
      back.href = '#blog';
      notice.append(back);
    }
    if (kind === 'error') {
      const retry = el('button', 'bl-btn', BLOG_COPY.retry);
      retry.type = 'button';
      retry.addEventListener('click', () => void load());
      notice.append(retry);
    }

    stage.replaceChildren(notice);
  }

  /* 正文 ---------------------------------------------------------------- */

  function render(current: PostDetail, initialReplies: ReplyView[], cursor: string | null): void {
    section.dataset.state = 'ok';
    replies = initialReplies;
    replyCursor = cursor;
    floors.clear();

    crumb.replaceChildren();
    const home = el('a', undefined, '社区');
    home.href = '#blog';
    crumb.append(home);
    if (current.category) {
      crumb.append(el('span', undefined, '/'), el('span', undefined, current.category.name));
    }

    const head = el('header', 'bp-head');
    head.append(el('h1', 'bp-title', current.title));

    const byline = el('div', 'bp-byline');
    byline.append(createBlogAvatar(current.author));
    byline.append(el('span', 'bp-byline__name', current.author.nickname));

    const badges = el('span', 'bp-badges');
    if (current.author.owner) badges.append(el('span', 'bp-badge bp-badge--owner', '站长'));
    if (current.locked) badges.append(el('span', 'bp-badge', '回复已关闭'));
    byline.append(badges);

    const published = el('time', 'bp-byline__time', formatDateTime(publishTimeOf(current)));
    published.dateTime = publishTimeOf(current);
    byline.append(el('span', 'bl-dot'), published);
    byline.append(
      el('span', 'bl-dot'),
      el('span', undefined, `${current.replyCount} 条回复`),
    );
    head.append(byline);

    if (current.tags.length > 0 || current.category) {
      const tagRow = el('div', 'bp-tags');
      if (current.category) {
        tagRow.append(el('span', 'bp-badge bp-badge--owner', current.category.name));
      }
      for (const label of current.tags) {
        tagRow.append(el('span', 'bl-tag', `#${label}`));
      }
      head.append(tagRow);
    }

    /* 左侧投票轨道 */
    const voteStatus = el('p', 'bp-vote-status');
    voteStatus.setAttribute('role', 'status');
    voteStatus.setAttribute('aria-live', 'polite');
    voteStatus.hidden = true;

    const postVotes = createVoteBar({
      up: current.up,
      down: current.down,
      value: current.myVote,
      variant: 'rail',
      onVote: (next) => void handlePostVote(current, postVotes, voteStatus, next),
    });

    const rail = el('aside', 'bp-rail');
    rail.append(postVotes.element, voteStatus);

    /* 正文 */
    const article = el('div', 'bp-article');
    const body = el('div', 'md-body');
    body.append(renderMarkdown(current.markdown));
    article.append(body);

    const foot = el('div', 'bp-foot');
    if (current.updatedAt !== publishTimeOf(current)) {
      const edited = el('time', undefined, `最后编辑 ${formatDateTime(current.updatedAt)}`);
      edited.dateTime = current.updatedAt;
      foot.append(edited);
    }
    const copy = el('button', 'bl-btn bl-btn--ghost bp-copy', '复制链接');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const url = `${window.location.origin}${window.location.pathname}#blog/${encodeURIComponent(current.slug)}`;
      void navigator.clipboard?.writeText(url).then(
        () => {
          copy.textContent = '已复制';
          window.setTimeout(() => {
            if (!closed) copy.textContent = '复制链接';
          }, 2000);
        },
        () => {
          copy.textContent = '复制失败';
        },
      );
    });
    foot.append(copy);
    article.append(foot);

    const layout = el('div', 'bp-layout');
    layout.append(rail, article);

    /* 回复区 */
    const repliesSection = el('section', 'bp-replies');
    const title = el('h2', 'bp-replies__title');
    const paintCount = (count: number): void => {
      title.textContent = `${BLOG_COPY.repliesTitle} · ${count}`;
    };
    paintCount(current.replyCount);
    repliesSection.append(title);

    // 空态放在标题下面、回复框上面：它应该在「要写点什么」之前提示，而不是垫在整个区块最底。
    const emptyHint = el('p', 'bl-state', BLOG_COPY.repliesEmpty);
    emptyHint.hidden = replies.length > 0;
    repliesSection.append(emptyHint);

    let form: ReturnType<typeof createReplyForm> | null = null;
    if (current.locked) {
      repliesSection.append(el('div', 'bp-locked', BLOG_COPY.replyLocked));
    } else {
      form = createReplyForm({
        submit: (input) => postReply(options.slug, input, abort.signal),
        requestCaptcha: async () => {
          const result = await fetchCaptcha(abort.signal);
          return result.ok ? result.data : null;
        },
        onPosted: (reply, count) => {
          // 引用条由回复框自己在成功后收起（它比页面更清楚这次提交带没带引用）。
          appendReply(reply);
          paintCount(count);
        },
      });
      formRef = form;
      form.setAuth(getAuthState());
      repliesSection.append(form.element);
    }

    const floorList = el('ol', 'bp-floors');
    for (const reply of replies) {
      floorList.append(mountFloor(reply));
    }
    repliesSection.append(floorList);

    const moreWrap = el('div', 'bl-more');
    const moreButton = el('button', 'bl-btn bl-btn--ghost bl-more__btn', BLOG_COPY.loadMore);
    moreButton.type = 'button';
    moreButton.addEventListener('click', () => void loadMoreReplies(moreButton));
    moreWrap.append(moreButton);
    moreWrap.hidden = replyCursor === null;
    repliesSection.append(moreWrap);

    stage.replaceChildren(head, layout, repliesSection);

    /* 回复相关的闭包 */
    function mountFloor(reply: ReplyView): HTMLElement {
      const handle = createFloor({
        reply,
        onReply: (floor, nickname) => form?.setReplyTo(floor, nickname),
        onVote: (target, next) => void handleReplyVote(target, handle, next),
      });
      floors.set(reply.id, handle);
      return handle.element;
    }

    function appendReply(reply: ReplyView): void {
      // 按 id 去重：可能已经通过「加载更多」把它取回来了。
      if (floors.has(reply.id)) return;
      emptyHint.hidden = true;
      const node = mountFloor(reply);
      floorList.append(node);
      replies.push(reply);
    }

    async function loadMoreReplies(button: HTMLButtonElement): Promise<void> {
      if (!replyCursor) return;
      button.disabled = true;
      button.textContent = BLOG_COPY.loadMoreLoading;
      const result = await fetchReplies(options.slug, replyCursor, abort.signal);
      if (closed) return;
      if (!result.ok) {
        button.disabled = false;
        button.textContent = BLOG_COPY.loadMoreError;
        return;
      }
      for (const reply of result.data.replies) {
        // 这里也去重：刚发的回复可能正好落在下一页里。
        if (floors.has(reply.id)) continue;
        floorList.append(mountFloor(reply));
        replies.push(reply);
      }
      replyCursor = result.data.nextCursor;
      moreWrap.hidden = replyCursor === null;
      button.disabled = false;
      button.textContent = BLOG_COPY.loadMore;
    }

    async function handleReplyVote(
      target: ReplyView,
      handle: FloorHandle,
      next: VoteValue,
    ): Promise<void> {
      if (getAuthState().status !== 'user') {
        requireLogin();
        return;
      }
      const result = await voteReply(target.id, next, abort.signal);
      if (closed) return;
      if (result.ok) {
        handle.setVote(result.data);
      } else if (result.status === 429) {
        voteStatus.hidden = false;
        voteStatus.textContent = result.message;
      }
    }
  }

  let formRef: ReturnType<typeof createReplyForm> | null = null;

  function requireLogin(): void {
    // 记住当前位置，登录成功后 `takeReturnTo()` 会把人送回来。
    rememberReturnTo(window.location.hash);
    options.navigate('login');
  }

  async function handlePostVote(
    current: PostDetail,
    bar: ReturnType<typeof createVoteBar>,
    status: HTMLElement,
    next: VoteValue,
  ): Promise<void> {
    if (getAuthState().status !== 'user') {
      requireLogin();
      return;
    }

    // 乐观更新：先把数字改掉，失败再回滚。等待 200ms 才变化的按钮会让人以为没点中。
    const previous = { up: current.up, down: current.down, value: current.myVote };
    const predicted = predict(previous, next);
    bar.set(predicted);
    bar.setBusy(true);

    const result = await votePost(options.slug, next, abort.signal);
    if (closed) return;

    bar.setBusy(false);
    if (result.ok) {
      bar.setResult(result.data);
      current.up = result.data.up;
      current.down = result.data.down;
      current.myVote = result.data.myVote;
      status.hidden = true;
      return;
    }

    bar.set(previous);
    status.hidden = false;
    status.textContent = result.message || BLOG_COPY.voteFailed;
  }

  function predict(
    state: { up: number; down: number; value: VoteValue },
    next: VoteValue,
  ): { up: number; down: number; value: VoteValue } {
    let { up, down } = state;
    if (state.value === 1) up -= 1;
    if (state.value === -1) down -= 1;
    if (next === 1) up += 1;
    if (next === -1) down += 1;
    return { up: Math.max(0, up), down: Math.max(0, down), value: next };
  }

  /* 加载 ---------------------------------------------------------------- */

  async function load(): Promise<void> {
    showNotice('loading', '');
    const result = await fetchPost(options.slug, abort.signal);
    if (closed) return;

    if (result.kind === 'ok') {
      document.title = `${result.page.post.title}${BLOG_TITLE_SUFFIX}`;
      render(result.page.post, result.page.replies, result.page.replyCursor);
      return;
    }
    if (result.kind === 'missing') {
      showNotice('missing', BLOG_COPY.missing);
      return;
    }
    if (!result.message) return; // 被主动取消
    showNotice('error', result.message || BLOG_COPY.detailError);
  }

  void load();

  // 登录态变化要驱动回复框（游客 ↔ 登录用户的验证区切换）。
  // `getAuthState()` 在首帧常常还是 unknown，所以订阅是必须的，不是优化。
  unsubscribe = subscribe((next) => {
    if (closed) return;
    formRef?.setAuth(next);
  });

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      abort.abort();
      unsubscribe?.();
      unsubscribe = null;
      formRef?.dispose();
      formRef = null;
      floors.clear();
      document.title = baseTitle;
    },
  };
}
