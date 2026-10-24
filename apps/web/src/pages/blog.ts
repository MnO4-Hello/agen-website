/**
 * 「博客」标签页。
 *
 * 目前是占位页，还没有文章列表与详情。文章要落地时，建议先在这里做列表，再给
 * 单篇加一条路由（`router.ts` 的 routes 里加 id，未知 id 会自动回落主页）。
 */

import { createPlaceholderPage } from './page-shell';
import type { RouteView } from '../router';

export function createBlogPage(): RouteView {
  return createPlaceholderPage('blog');
}
