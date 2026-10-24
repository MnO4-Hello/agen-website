/**
 * 「留言」标签页。
 *
 * 目前是占位页。留言要能真的收下来，得先有落库与提交接口（`apps/api` 里加路由），
 * 那时候这一页再换成表单 + 列表。
 */

import { createPlaceholderPage } from './page-shell';
import type { RouteView } from '../router';

export function createMessagePage(): RouteView {
  return createPlaceholderPage('message');
}
