/**
 * 标签页的文案。
 *
 * 这三个页面目前**只建了骨架、没有内容**：每个页面一句标题 + 一句说明，等真正要写
 * 内容时，把对应页面的 `pages/xxx.ts` 换成真实布局即可，这里只留标题与说明文字。
 *
 * 「作品」页已经接管成真实列表（`pages/works.ts`），所以不在这张表里——它的空态、
 * 错误态文案跟着数据走，不写死。
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
  blog: {
    title: '博客',
    note: '这一页已经建好，还没有写下第一篇。',
  },
  message: {
    title: '留言',
    note: '这一页已经建好，留言板还没有接上。',
  },
  about: {
    title: '关于我',
    note: '这一页已经建好，自我介绍还在写。',
  },
} as const satisfies Record<string, PageCopy>;

/** 占位页的路由 id（与导航项同名）。 */
export type PlaceholderPageId = keyof typeof PAGE_COPY;
