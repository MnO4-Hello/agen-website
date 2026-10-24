/**
 * 管理后台的小工具：建节点、格式化、图标。
 *
 * 没有框架，所以每个视图都是「建节点 + 拼起来」。这里只放**反复要用**的那几样，
 * 顺手也把「文件大小 / 时间」的格式统一在一处——不然控制台写 `HH:mm:ss`、文件列表写
 * `YYYY/MM/DD`，同一页里看着像两个产品。
 *
 * ⚠️ 所有用户/文件名一律走 `textContent`，这个文件里不许出现 `innerHTML`。
 */

type Child = Node | string | null | undefined;

export interface ElOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

export interface ButtonOptions {
  className?: string;
  title?: string;
  icon?: IconName;
  text?: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const node = el('button', {
    className: options.className ?? 'admin-btn',
    attrs: { type: 'button', title: options.title ?? null },
  });
  node.disabled = options.disabled === true;
  if (options.icon) node.append(icon(options.icon));
  if (options.text) node.append(el('span', { text: options.text }));
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/* ---------------------------------------------------------------------------
   格式化
--------------------------------------------------------------------------- */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `20:38:42`——控制台每一行用。 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `10-23 20:38`——文件列表用（今年就不显示年份，省一列宽度）。 */
export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const prefix = sameYear ? '' : `${date.getFullYear()}-`;
  return `${prefix}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `2 小时 13 分`。 */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}

/* ---------------------------------------------------------------------------
   图标（内联 SVG，不引图标库）
--------------------------------------------------------------------------- */

const ICON_PATHS = {
  terminal: ['M4 4h16v16H4z', 'M8 10l2.5 2L8 14', 'M12.5 15H16'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  file: ['M6 3h7l5 5v13H6z', 'M13 3v5h5'],
  image: ['M4 5h16v14H4z', 'M4 15l4-4 4 4 3-3 5 5', 'M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z'],
  code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3h16v-3'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v4h-4'],
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['M7 4l13 8-13 8z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  pencil: ['M4 20h4l11-11-4-4L4 16z', 'M14 5l4 4'],
  chevron: ['M9 6l6 6-6 6'],
  logout: ['M14 4h5v16h-5', 'M10 12H3', 'M7 8l-4 4 4 4'],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v6h8V4', 'M8 15h8'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  users: ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M2 20c0-3.3 2.7-5 6-5s6 1.7 6 5', 'M16 5a3 3 0 0 1 0 6', 'M15 15c3 0 5 1.7 5 5'],
  pen: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  // 「复制链接」用（公开主页）。画的是两个套在一起的环——比链条真实图标更省 path。
  link: [
    'M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1 1',
    'M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M4 12H2M22 12h-2M12 4V2M12 22v-2M6 6L4.5 4.5M19.5 19.5L18 18M18 6l1.5-1.5M4.5 19.5L6 18',
  ],
} as const;

export type IconName = keyof typeof ICON_PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
