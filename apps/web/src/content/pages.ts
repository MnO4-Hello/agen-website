/**
 * 占位页的文案。
 *
 * 现在只剩「关于我」还用这套骨架：一句标题 + 一句说明。等那一页要写内容时，把
 * `pages/about.ts` 换成自己的布局即可。
 *
 * 「作品」「博客」「留言」都已经接管成真实模块（`pages/works.ts` / `pages/blog.ts` /
 * `pages/message.ts`），所以不在这张表里——它们的空态、错误态文案跟着数据走，不写死。
 */

export interface PageCopy {
  /** 页面大标题，与导航项一致。 */
  readonly title: string;
  /** 一句说明，写清「这页还在搭」。 */
  readonly note: string;
}

/** 通用返回链接的文案（占位页共用）。 */
export const PAGE_BACK_LABEL = '回到主页';

/** 占位页右上角的小标，说明这页「还没内容」是故意的。 */
export const PAGE_BADGE = '筹备中';

export const PAGE_COPY = {
  about: {
    title: '关于我',
    note: '这一页已经建好，自我介绍还在写。',
  },
} as const satisfies Record<string, PageCopy>;

/** 占位页的路由 id（与导航项同名）。 */
export type PlaceholderPageId = keyof typeof PAGE_COPY;

/**
 * 「整站关闭」页的文案（`SITE_MODE=maintenance`，见 `site/config.ts`）。
 *
 * 独立一份而不是塞进 `PAGE_COPY`：那张表是按路由 id 索引的占位页，而这一页不挂在
 * 任何路由上——它连导航栏都不渲染，是外壳之前的最后一道门。
 */
export const MAINTENANCE_COPY = {
  /** 顶部小标。写「备案中」而不是「维护中」：审核员一看就知道在做什么。 */
  badge: '备案中',
  title: '正在办理备案',
  /** 说明留在页面上：管局核查时这就是「站点已主动关闭」的证据。 */
  note: '这个站在办理网站备案，期间暂时关闭访问。备案通过后会重新开放，有事可以邮件联系。',
  mailLabel: '写信给我',
} as const;
