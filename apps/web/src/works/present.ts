/**
 * 纯函数层：把 API 的 `WorkSummary` 变成页面能直接用的形状。
 *
 * 单独放一个文件，而不是塞进页面里，有两个理由：
 *   1. 首页作品墙与作品列表页都要「没有缩略图时给个稳定的配色」，逻辑必须只有一份；
 *   2. 纯函数可以被回归测试直接喂数据（见 `.workbuddy/tmp/dom-test.mjs`）。
 */

import { WORK_CARD_COUNT, type WorkCardContent } from '../content/works';
import type { WorkSummary } from './api';

/**
 * 首页作品墙的最少张数。
 *
 * `s-work` 是一段 17 屏的钉住叙事，行程 = 张数 × 50lvh。只有一个作品时如果只放一张卡，
 * 那段只有 50lvh，遮罩还没张开就结束了——视觉上像「页面塌了一块」。所以张数不足时
 * **循环填充**（同一个作品出现多次，图注编号仍然各不相同），保证墙是墙。
 */
export const WALL_MIN_CARDS = 8;

/** 上限沿用原来的 34：再多会把这段行程顶到 1700lvh 以上，页面长得没道理。 */
export const WALL_MAX_CARDS = WORK_CARD_COUNT;

/**
 * 数据 → 作品墙卡片。
 *
 * `href` 用站内哈希（`#works/<slug>`）：`scene/work-card.ts` 会据此判断「同页跳转」，
 * 不加 `target="_blank"`。空数据返回空数组——调用方据此保留原有的占位墙，
 * 绝不把板块高度写成 0。
 */
export function toWallCards(works: readonly WorkSummary[]): WorkCardContent[] {
  if (works.length === 0) return [];

  const capped = works.slice(0, WALL_MAX_CARDS);
  const total = Math.min(Math.max(capped.length, WALL_MIN_CARDS), WALL_MAX_CARDS);
  const cards: WorkCardContent[] = [];

  for (let index = 0; index < total; index += 1) {
    const work = capped[index % capped.length];
    if (!work) continue;
    cards.push({
      title: work.title,
      // 编号仍按墙上的序号走，重复出现的那几张也就不会撞图注。
      code: String(index).padStart(4, '0'),
      href: `#works/${encodeURIComponent(work.slug)}`,
      src: work.thumbnail || undefined,
      media: 'image',
      external: false,
    });
  }

  return cards;
}

/**
 * 由 slug 派生一个稳定的色相（138~178，与首页占位卡的内联 SVG 同一区间）。
 *
 * 用 slug 而不是数组下标：作品排序一变，同一张卡的封面颜色不该跟着跳。
 */
export function coverHue(slug: string): number {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  }
  return 138 + (hash % 9) * 5;
}

/** `2026-10-23T...` → `2026-10`。详情页侧栏与列表卡都用它，别各写一份。 */
export function formatMonth(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
