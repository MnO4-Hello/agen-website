/**
 * 「关于我」标签页。
 *
 * 目前是占位页。自我介绍的正文本体在 `content/profile.ts`（首页「我是谁？」那段在用），
 * 这一页要写的时候可以直接复用同一份文案，别抄成两份。
 */

import { createPlaceholderPage } from './page-shell';
import type { RouteView } from '../router';

export function createAboutPage(): RouteView {
  return createPlaceholderPage('about');
}
