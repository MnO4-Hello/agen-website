/**
 * 原图查看页（`#photo/<文件名>`，例如 `#photo/w-0a3a94442b2ed304.png`）。
 *
 * 为什么路由参数是**文件名**而不是完整 URL：`router.ts` 的第二段不能含 `/`
 * （`readParam()` 会直接判为非法），而文件名的前缀（`b`/`m`/`w`/`a`）已经唯一
 * 确定了它属于哪个图床。比「编码整条 URL」更短、更不可能被解错。
 *
 * 这一页**不发任何接口请求**：URL 由 `mediaUrlOfName()` 拼出来，像素尺寸在
 * `load` 事件里读 `naturalWidth/naturalHeight`。多一次往返只会让「看图」变慢。
 *
 * 显示的是**原图**——站点其它位置一律显示压缩过的副本（见 `shared/media.ts`），
 * 只有点进来这一页才付原图那份流量。
 */

import type { RouteView } from '../router';
import { consumePhotoOrigin, mediaUrlOfName } from '../shared/media';

export interface PhotoPageOptions {
  /** 地址栏第二段：原图文件名。 */
  readonly name: string;
}

export function createPhotoPage(options: PhotoPageOptions): RouteView {
  const section = document.createElement('section');
  section.className = 'photo';

  const stage = document.createElement('div');
  stage.className = 'photo__stage';

  const head = document.createElement('header');
  head.className = 'photo__head';

  const title = document.createElement('h1');
  title.className = 'photo__title';
  title.textContent = '原图';

  const meta = document.createElement('p');
  meta.className = 'photo__meta';
  meta.textContent = '正在读取…';

  // 返回目标是**跳转前那一页**（存在 sessionStorage 里），没有就回首页。
  const back = document.createElement('a');
  back.className = 'photo__pill';
  back.href = consumePhotoOrigin();
  back.textContent = '返回';

  head.append(title, meta, back);

  const figure = document.createElement('figure');
  figure.className = 'photo__figure';

  const baseTitle = document.title;
  document.title = '原图 · 阿根';

  let image: HTMLImageElement | null = null;
  let closed = false;

  const src = mediaUrlOfName(options.name);
  if (!src) {
    // 名字形状不对（被手改过的链接、或者三段以上的旧地址）。
    meta.textContent = '这个地址不是站内图片。';
    section.classList.add('photo--error');
  } else {
    const img = document.createElement('img');
    img.className = 'photo__image';
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'eager';

    img.addEventListener('load', () => {
      if (closed) return;
      meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${options.name}`;
      section.classList.add('is-ready');
    });

    img.addEventListener('error', () => {
      if (closed) return;
      meta.textContent = '这张图已经不在了。';
      section.classList.add('photo--error');
    });

    img.src = src;
    image = img;
    figure.append(img);
  }

  stage.append(head, figure);
  section.append(stage);

  return {
    elements: [section],
    dispose: () => {
      closed = true;
      /*
       * 把 `src` 清空 —— 换页之后没人再要这张原图，继续下载纯属浪费带宽
       * （原图可能有几十 MB，而这站的瓶颈就是下行）。
       */
      if (image) {
        image.src = '';
        image = null;
      }
      document.title = baseTitle;
    },
  };
}
