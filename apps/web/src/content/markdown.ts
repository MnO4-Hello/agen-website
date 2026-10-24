/**
 * 一个**只够用**的 Markdown 渲染器：把作品详情里的 README 变成 DOM 节点。
 *
 * 为什么自己写：
 *   1. 全站零依赖（`apps/web` 的运行时依赖只有 gsap 与 lenis），为了一个 README 引
 *      marked / markdown-it 不划算；
 *   2. 管理后台有一条硬约定「不许用 `innerHTML`」——渲染器的产物是**节点树**，
 *      天然满足这条，不需要先拼 HTML 再消毒（消毒漏一个属性就是 XSS）。
 *
 * 支持的子集（够写一份项目说明，超出的一律当普通文本显示）：
 *   标题 `#`~`######` · 段落 · 围栏代码块 · 无序/有序列表 · 引用 · 分割线 ·
 *   行内代码 · 加粗 · 链接 · 图片。
 *
 * **刻意不支持**：原始 HTML（`<script>` 会被当成文字显示）、表格、脚注、嵌套列表、
 * 标题锚点。少一个特性就少一类注入面，需要时再单独加，别顺手放行。
 */

/** 围栏行：``` 或 ```ts（语言名只用于 `data-lang`，不做高亮）。 */
const FENCE = /^```([\w-]+)?\s*$/;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/**
 * 行内标记。顺序有意义：图片必须排在链接之前（`![a](b)` 也满足链接的正则）。
 *
 * 分组：1-2 图片、3 行内代码、4 加粗、5-6 链接。
 */
const INLINE = /!\[([^\]\n]*)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * 只放行 http/https。
 *
 * 理由：`javascript:` / `data:` 链接在 Markdown 里是最常见的一条注入路径，而作品
 * 正文是后台手填的——但后台账号也可能被人在公用电脑上忘关。放行白名单比事后过滤稳。
 */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function inline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(document.createTextNode(text.slice(last, at)));

    const [, alt, imageUrl, code, strong, linkText, linkUrl] = match;

    if (imageUrl !== undefined) {
      const href = safeUrl(imageUrl);
      if (href) {
        const img = document.createElement('img');
        img.src = href;
        img.alt = alt ?? '';
        img.loading = 'lazy';
        img.decoding = 'async';
        // 图片来自外站时别把 Referer 送出去（顺手保护一下作品里引用的第三方图床）。
        img.referrerPolicy = 'no-referrer';
        out.push(img);
      } else {
        out.push(document.createTextNode(alt ?? ''));
      }
    } else if (code !== undefined) {
      const node = document.createElement('code');
      node.textContent = code;
      out.push(node);
    } else if (strong !== undefined) {
      const node = document.createElement('strong');
      node.append(...inline(strong));
      out.push(node);
    } else if (linkText !== undefined && linkUrl !== undefined) {
      /*
       * `#` 开头的站内锚点降级成纯文本。
       *
       * 本站的路由就挂在地址栏哈希上：`[跳到第二节](#section-2)` 一点就会把路由切到
       * `#section-2`——那是未知路由，整页会被送回首页。降级比「点了跳首页」好。
       */
      if (linkUrl.startsWith('#')) {
        out.push(document.createTextNode(linkText));
      } else {
        const href = safeUrl(linkUrl);
        if (href) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noreferrer noopener';
          a.append(...inline(linkText));
          out.push(a);
        } else {
          out.push(document.createTextNode(linkText));
        }
      }
    }

    last = at + match[0].length;
  }

  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function heading(level: number, text: string): HTMLElement {
  // `h1` 留给页面标题，正文从 `h2` 起——否则一个 README 里写 `# 项目名` 会出现两个 h1。
  const tag = (`h${Math.min(6, level + 1)}`) as 'h2';
  const node = document.createElement(tag);
  node.append(...inline(text));
  return node;
}

/**
 * 渲染入口。
 *
 * 返回 `DocumentFragment` 而不是 HTML 字符串：调用方 `append()` 进去就行，
 * 全程没有一处拼字符串的行内标记，也就不存在「忘了转义」这件事。
 */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const node = document.createElement('p');
    node.append(...inline(paragraph.join(' ')));
    fragment.append(node);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // 跳掉收尾的 ```（没写收尾时 index 已经到底，再 +1 也不会越界）。
      index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.lang = fence[1];
      // textContent：代码原样保留，缩进与 `<` `&` 都不会被当成标记。
      code.textContent = body.join('\n');
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const head = HEADING.exec(line);
    if (head) {
      flushParagraph();
      fragment.append(heading(head[1]?.length ?? 1, head[2] ?? ''));
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      fragment.append(document.createElement('hr'));
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const inner: string[] = [];
      while (index < lines.length) {
        const current = QUOTE.exec(lines[index] ?? '');
        if (!current) break;
        inner.push(current[1] ?? '');
        index += 1;
      }
      const block = document.createElement('blockquote');
      // 引用里允许再出现列表/代码块，递归一次最省事。
      block.append(renderMarkdown(inner.join('\n')));
      fragment.append(block);
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = unordered ? null : ORDERED.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered ? ORDERED.exec(current) : UNORDERED.exec(current);
        if (!match) break;
        const item = document.createElement('li');
        item.append(...inline(match[1] ?? ''));
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return fragment;
}
