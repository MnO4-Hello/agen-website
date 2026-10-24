/**
 * 作品详情页（`#works/<slug>`）。两种形态：
 *
 *   · **模板模式**：站点统一版式——面包屑 / 标题 / 简介 / 标签 / 操作按钮 / README /
 *     图集 / 右侧信息栏。版式参考 GitHub 的仓库页（正文左侧、事实右侧、顶部一排动作）。
 *   · **开发者模式**：把后台写的整页 HTML 塞进**沙箱 iframe**（`srcdoc`）。站内只剩一枚
 *     悬浮返回胶囊，其余完全不干预——这就是「完全自定义」的含义。
 *
 * ⚠️ iframe 的 `sandbox` **绝不能带 `allow-same-origin`**：它与 `allow-scripts` 同时出现
 * 等于没有沙箱（内嵌页可以直接拿到本站的 cookie 与 DOM）。这里给的是
 * `allow-scripts allow-forms allow-modals allow-popups`——够写一个交互页面，但进不了本站。
 *
 * 页面**同步建壳、异步填数据**：`router.start()` 必须同步完成首屏（headless 截图就在
 * `load` 附近抓帧），所以 `createWorkDetailPage()` 只挂一个骨架，数据到了再替换内容。
 */

import { renderMarkdown } from '../content/markdown';
import type { RouteView } from '../router';
import { fetchWork, type WorkDetail } from '../works/api';
import { formatMonth } from '../works/present';

export interface WorkDetailPageOptions {
  /** 地址栏第二段（`#works/<slug>` 的 slug）。 */
  readonly slug: string;
}

/** 开发者模式 iframe 允许的能力。**故意不含 `allow-same-origin`**，理由见文件头。 */
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

export function createWorkDetailPage(options: WorkDetailPageOptions): RouteView {
  const section = document.createElement('section');
  section.className = 'wdetail';

  /** 内容容器：loading / missing / error / ok 都在这里换，section 本身不动。 */
  const stage = document.createElement('div');
  stage.className = 'wdetail__stage';
  section.append(stage);

  let closed = false;
  let frame: HTMLIFrameElement | null = null;
  const abort = new AbortController();
  const baseTitle = document.title;

  /* —— 三种非正常态 —— */

  const showNotice = (kind: 'loading' | 'missing' | 'error', message: string): void => {
    const box = document.createElement('div');
    box.className = `wdetail__notice${kind === 'loading' ? ' is-loading' : ''}`;

    const text = document.createElement('p');
    text.className = 'wdetail__notice-text';
    text.textContent = message;
    box.append(text);

    if (kind !== 'loading') {
      const back = document.createElement('a');
      back.className = 'wdetail__pill';
      back.href = '#works';
      back.textContent = '返回作品列表';
      box.append(back);
    }

    if (kind === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'wdetail__pill is-ghost';
      retry.textContent = '重试';
      retry.addEventListener('click', () => void load());
      box.append(retry);
    }

    stage.replaceChildren(box);
  };

  /* —— 模板模式 —— */

  const buildHead = (work: WorkDetail): HTMLElement => {
    const head = document.createElement('header');
    head.className = 'wdetail__head';

    const crumb = document.createElement('nav');
    crumb.className = 'wdetail__crumb';
    crumb.setAttribute('aria-label', '面包屑');
    const back = document.createElement('a');
    back.href = '#works';
    back.textContent = '作品';
    const separator = document.createElement('span');
    separator.className = 'wdetail__crumb-sep';
    separator.textContent = '/';
    separator.setAttribute('aria-hidden', 'true');
    const tail = document.createElement('span');
    tail.className = 'wdetail__crumb-current';
    tail.textContent = work.slug;
    crumb.append(back, separator, tail);

    const title = document.createElement('h1');
    title.className = 'wdetail__title';
    title.textContent = work.title;

    head.append(crumb, title);

    if (work.summary) {
      const summary = document.createElement('p');
      summary.className = 'wdetail__summary';
      summary.textContent = work.summary;
      head.append(summary);
    }

    if (work.tags.length > 0) {
      const tags = document.createElement('ul');
      tags.className = 'wdetail__tags';
      tags.setAttribute('aria-label', '技术栈');
      for (const tag of work.tags) {
        const item = document.createElement('li');
        item.className = 'wdetail__tag';
        item.textContent = tag;
        tags.append(item);
      }
      head.append(tags);
    }

    const actions = document.createElement('div');
    actions.className = 'wdetail__actions';
    if (work.demoUrl) {
      actions.append(buildAction(work.demoUrl, '在线预览', 'is-primary'));
    }
    if (work.repoUrl) {
      actions.append(buildAction(work.repoUrl, '源码'));
    }
    if (actions.childElementCount > 0) head.append(actions);

    return head;
  };

  const buildAction = (href: string, label: string, modifier = ''): HTMLAnchorElement => {
    const link = document.createElement('a');
    link.className = `wdetail__pill${modifier ? ` ${modifier}` : ''}`;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = label;
    return link;
  };

  const buildSide = (work: WorkDetail): HTMLElement => {
    const side = document.createElement('aside');
    side.className = 'wdetail__side';

    const facts = document.createElement('dl');
    facts.className = 'wdetail__facts';
    const rows: Array<[string, string]> = [
      ['年份', work.year],
      ['分类', work.category],
      ['更新', formatMonth(work.updatedAt)],
      ['形态', work.mode === 'developer' ? '自定义页面' : '模板页面'],
    ];
    for (const [label, value] of rows) {
      if (!value) continue;
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      facts.append(term, detail);
    }
    if (facts.childElementCount > 0) side.append(facts);

    if (work.gallery.length > 0) {
      const note = document.createElement('p');
      note.className = 'wdetail__side-note';
      note.textContent = `${work.gallery.length} 张图集见正文下方。`;
      side.append(note);
    }

    return side;
  };

  const renderTemplate = (work: WorkDetail): void => {
    const head = buildHead(work);

    /*
     * 有封面就先给一条横幅。
     *
     * 列表页的缩略图决定了「点不点进来」，进来之后这条横幅是同一张图的延续——
     * 没有它，详情页会显得比列表页还素。用 `aspect-ratio` 固定比例 + `object-fit: cover`，
     * 作者传 16:9 还是 21:9 都不会把版面撑破。
     */
    let cover: HTMLElement | null = null;
    if (work.thumbnail) {
      const figure = document.createElement('figure');
      figure.className = 'wdetail__cover';
      const img = document.createElement('img');
      img.src = work.thumbnail;
      img.alt = '';
      img.decoding = 'async';
      figure.append(img);
      cover = figure;
    }

    const main = document.createElement('article');
    main.className = 'wdetail__main';

    const body = document.createElement('div');
    body.className = 'md-body';
    if (work.readme.trim()) {
      body.append(renderMarkdown(work.readme));
    } else {
      const empty = document.createElement('p');
      empty.className = 'md-body__empty';
      empty.textContent = '这个作品还没有写说明。';
      body.append(empty);
    }
    main.append(body);

    if (work.gallery.length > 0) {
      const gallery = document.createElement('section');
      gallery.className = 'wdetail__gallery';
      const heading = document.createElement('h2');
      heading.className = 'wdetail__gallery-title';
      heading.textContent = '图集';
      gallery.append(heading);

      const shots = document.createElement('div');
      shots.className = 'wdetail__shots';
      for (const src of work.gallery) {
        const link = document.createElement('a');
        link.className = 'wdetail__shot';
        link.href = src;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        link.append(img);
        shots.append(link);
      }
      gallery.append(shots);
      main.append(gallery);
    }

    const layout = document.createElement('div');
    layout.className = 'wdetail__layout';
    layout.append(main, buildSide(work));

    stage.replaceChildren(...[head, cover, layout].filter((node): node is HTMLElement => node !== null));
    stage.className = 'wdetail__stage';
  };

  /* —— 开发者模式 —— */

  const renderDeveloper = (work: WorkDetail): void => {
    section.classList.add('wdetail--dev');
    stage.className = 'wdetail__stage is-frame';

    const back = document.createElement('a');
    back.className = 'wdetail__back';
    back.href = '#works';
    back.textContent = '作品';

    const iframe = document.createElement('iframe');
    iframe.className = 'wdetail__frame';
    iframe.title = work.title || '作品页面';
    iframe.setAttribute('sandbox', FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    // 用属性赋值而不是拼字符串——拼出来的 `srcdoc="..."` 里引号迟早会出事。
    iframe.srcdoc = work.html || '<!doctype html><meta charset="utf-8"><p>这个作品还没有内容。</p>';
    frame = iframe;

    stage.replaceChildren(insertFrame(iframe, back));
  };

  /**
   * iframe 之外只放一枚返回胶囊。
   *
   * 顺序上先 append 胶囊再 append iframe，是为了让胶囊在 DOM 里排前面（读屏先读到它），
   * 视觉层级交给 CSS 的 `z-index`，不靠节点顺序。
   */
  const insertFrame = (iframe: HTMLIFrameElement, back: HTMLElement): HTMLElement => {
    const wrap = document.createElement('div');
    wrap.className = 'wdetail__frame-wrap';
    wrap.append(back, iframe);
    return wrap;
  };

  const render = (work: WorkDetail): void => {
    document.title = work.title ? `${work.title} · 阿根` : baseTitle;
    // 每次渲染前先撤掉上一次的形态类，避免「模板 → 自定义」之间切换时残留。
    section.classList.remove('wdetail--dev');
    if (work.mode === 'developer') renderDeveloper(work);
    else renderTemplate(work);
  };

  /* —— 加载 —— */
  async function load(): Promise<void> {
    showNotice('loading', '正在读取作品…');
    const result = await fetchWork(options.slug, abort.signal);
    if (closed) return;

    if (result.kind === 'ok') {
      render(result.work);
      return;
    }
    if (result.kind === 'missing') {
      showNotice('missing', `没有找到「${options.slug}」这个作品，可能已经下线或链接写错了。`);
      return;
    }
    // 空 message 是「被主动取消」：视图已经拆了，不用再画任何东西。
    if (!result.message) return;
    showNotice('error', result.message);
  }

  void load();

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      abort.abort();
      /*
       * 先把 srcdoc 清空再交给路由移除节点。
       *
       * 只是 `remove()` 的话，iframe 里的脚本要等垃圾回收才停——如果它正在跑动画或
       * 定时器，会在后台继续吃 CPU（DevTools 的 Performance 里能看到）。清空 srcdoc
       * 会让浏览器立刻导航到 about:blank，脚本当场结束。
       */
      if (frame) {
        frame.srcdoc = '';
        frame = null;
      }
      document.title = baseTitle;
    },
  };
}
