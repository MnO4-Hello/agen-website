/**
 * 博客里的展示格式化。
 *
 * 都是纯函数，不碰 DOM——这样 `blog-test.mjs` 可以直接 import 断言，不需要模拟时钟。
 */

/** 相对时间：列表里「3 小时前」比「2026-10-26 18:03」更好扫读。 */
export function formatRelative(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';

  const diff = Date.now() - time;
  if (diff < 0) return '刚刚';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDateTime(iso).slice(0, 10);
}

/** 绝对时间：`2026-10-26 18:03`。用本地时区，和读者的直觉一致。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 计数：上万用「万」，避免列表里出现 12345 这种要数位数的数字。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(value));
}

export function floorLabel(floor: number): string {
  return `#${floor}`;
}

/** 「首次发布 / 最后编辑」这类时间的兜底：没发布过就给创建时间。 */
export function publishTimeOf(post: { publishedAt: string | null; createdAt: string }): string {
  return post.publishedAt ?? post.createdAt;
}
