/**
 * 点图看大图。
 *
 * 只做一件事：把一张图铺满视口。**刻意不做**上一张/下一张、缩放、拖拽——留言里的图通常
 * 一两张，多一层手势状态就多一类「点着点着卡住了」的 bug。关掉的方式给足三种：点遮罩、
 * 点右上角、按 Esc。
 *
 * 单例：同一时刻只可能有一个遮罩，重复打开会先把旧的收掉（否则会给 body 叠两层
 * `overflow: hidden`，关掉一层就再也滚不动了）。
 */

let overlay: HTMLElement | null = null;
let previousOverflow = '';

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeLightbox();
}

export function closeLightbox(): void {
  if (!overlay) return;
  document.removeEventListener('keydown', onKey);
  overlay.remove();
  overlay = null;
  document.body.style.overflow = previousOverflow;
}

export function openLightbox(url: string, alt = ''): void {
  closeLightbox();

  const root = document.createElement('div');
  root.className = 'mb-lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', alt || '查看大图');

  const image = document.createElement('img');
  image.className = 'mb-lightbox__image';
  image.src = url;
  image.alt = alt;

  const close = document.createElement('button');
  close.className = 'mb-lightbox__close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');

  root.append(image, close);
  // 点遮罩就关；点图片本身不关（想细看的人会不小心点到）。
  root.addEventListener('click', (event) => {
    if (event.target === root) closeLightbox();
  });
  close.addEventListener('click', () => closeLightbox());
  document.addEventListener('keydown', onKey);

  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.body.append(root);
  overlay = root;

  // 下一帧再加 `is-open`，让 CSS 的淡入真的跑一遍，而不是「一插进文档就已经是终态」。
  requestAnimationFrame(() => root.classList.add('is-open'));
}
