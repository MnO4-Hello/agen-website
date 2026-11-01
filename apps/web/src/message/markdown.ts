/**
 * 留言板里所有 Markdown 的唯一出口。
 *
 * `shared/markdown.ts` 是「作者自己写的正文」用的，它放行任意 http(s) 图片。留言是
 * **公开的、谁都能写的** UGC，那条例外会变成：
 *   · 第三方统计像素——谁看过这条留言、什么时间、什么 IP，图床主人全知道；
 *   · 本站被当成任意图床的代理。
 *
 * 所以这里在渲染之后再过一遍：**只保留本站留言图片直链**，其余 `<img>` 降级成普通链接
 * （用户仍然点得动，只是不会自动加载）。改的是产物，不是 `shared/markdown.ts`——
 * 博客与作品的正文还在用它的宽松策略。
 */

import { renderMarkdown } from '../shared/markdown';

/** 与 `apps/api/src/message/types.ts` 的 `MESSAGE_IMAGE_PREFIX` 保持一致。 */
const MEDIA_PATH = '/api/messages/media/';

function isOurImage(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith(MEDIA_PATH);
  } catch {
    return false;
  }
}

export function renderMessageMarkdown(source: string): DocumentFragment {
  const fragment = renderMarkdown(source);
  for (const img of Array.from(fragment.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (isOurImage(src)) {
      // 顺手改回相对路径：换域名/换端口时不会写死 origin。
      img.setAttribute('src', new URL(src, window.location.href).pathname);
      continue;
    }
    const link = document.createElement('a');
    link.href = src;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = img.alt || src;
    img.replaceWith(link);
  }
  return fragment;
}
