/**
 * 「设置」页的数据源（与 `account-source.ts` / `post-source.ts` 同一个思路）。
 *
 * 抽这一层不是为了「将来换后端」，是为了 `?preview=settings` 能用假快照把版面画出来——
 * 直接调真接口的话，DEV 截图通道里没有管理员 cookie，视图会 401 后把自己踢回登录页。
 */

import { fetchSiteMode, updateSiteMode, type ApiResult, type SiteModeSnapshot } from './api';
import type { SiteMode } from '../site/config';

export interface SiteModeWriteResult {
  site: SiteModeSnapshot;
  changed: boolean;
}

export interface SiteModeSource {
  read(): Promise<ApiResult<{ site: SiteModeSnapshot }>>;
  write(mode: SiteMode): Promise<ApiResult<SiteModeWriteResult>>;
}

export const liveSiteModeSource: SiteModeSource = {
  read: () => fetchSiteMode(),
  write: (mode) => updateSiteMode(mode),
};
