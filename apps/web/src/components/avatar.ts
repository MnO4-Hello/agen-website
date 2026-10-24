/**
 * 默认头像：昵称首字 + 一档派生色。
 *
 * 本期不做头像上传（`UserRecord.avatarUrl` 已经留好了字段），所以每个人都要有一个
 * 稳定的、看起来不像「占位灰块」的头像。取首字 + 从固定色板里按昵称哈希挑一档，
 * 同一个昵称永远得到同一个颜色——换设备、换浏览器都一样。
 *
 * 色板刻意只有六档、且都在品牌绿附近，避免导航栏右上角出现一个跳脱的色块。
 */

export type AvatarSize = 'sm' | 'lg';

export interface AvatarOptions {
  nickname: string;
  /** 有图就用图（以后接上传时才有值）；加载失败自动退回首字。 */
  avatarUrl?: string;
  size?: AvatarSize;
}

const PALETTE = [
  ['#3f7d58', '#f1f8ef'],
  ['#4c6f8a', '#eef3f7'],
  ['#7d6a3f', '#f8f4e8'],
  ['#6b5a8a', '#f3eff8'],
  ['#8a5a55', '#f9efed'],
  ['#3f7d70', '#eaf6f3'],
] as const;

/** 昵称首字。中文取第一个字，英文取首字母大写；空昵称给一个中性字符。 */
export function avatarInitial(nickname: string): string {
  const first = Array.from(nickname.trim())[0];
  return first ? first.toUpperCase() : '·';
}

function paletteOf(seed: string): readonly [string, string] {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100_000;
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0];
}

export function createAvatar(options: AvatarOptions): HTMLElement {
  const root = document.createElement('span');
  root.className = `avatar avatar--${options.size ?? 'sm'}`;
  root.setAttribute('aria-hidden', 'true');

  const url = options.avatarUrl?.trim();
  if (url) {
    const image = document.createElement('img');
    image.className = 'avatar__image';
    image.src = url;
    image.alt = '';
    // 图挂了就退回首字，别在导航栏上留一个破图标。
    image.addEventListener('error', () => {
      image.remove();
      paintInitial(root, options.nickname);
    });
    root.append(image);
    return root;
  }

  paintInitial(root, options.nickname);
  return root;
}

function paintInitial(root: HTMLElement, nickname: string): void {
  const [background, color] = paletteOf(nickname || '·');
  root.style.background = background;
  root.style.color = color;
  root.textContent = avatarInitial(nickname);
}
