/**
 * 后台帖子视图的数据源。
 *
 * 与 `views/works.ts` 的 `WorksSource` 同一个套路：视图只认这个接口，生产注入
 * `livePostsSource`（直接调 `api.ts`），DEV 可以注入假数据来看样式。
 *
 * 为什么抽出来而不是让视图直接 import `../api`：`api.ts` 里的函数是「一个接口一个函数」，
 * 视图里会散落十几处 `if (!result.ok)`；收成一个接口之后，视图只关心「成功拿到什么」，
 * 而测试/预览换实现也只改这一处。
 */

import {
  createAdminCategory,
  createAdminPost,
  deleteAdminCategory,
  deleteAdminPost,
  fetchAdminCategories,
  fetchAdminPost,
  fetchAdminPosts,
  fetchAdminReplies,
  fetchBlogMeta,
  reorderAdminCategories,
  setAdminPostStatus,
  setAdminReplyStatus,
  updateAdminCategory,
  updateAdminPost,
  type AdminCategory,
  type AdminPost,
  type AdminPostInput,
  type AdminPostStatus,
  type AdminReply,
  type AdminReplyStatus,
  type ApiResult,
  type BlogMeta,
  type SavedMedia,
  uploadBlogMedia,
} from '../api';

export interface PostsSource {
  meta(): Promise<ApiResult<BlogMeta>>;
  list(query: { q: string; status: string; cat: string }): Promise<ApiResult<{ posts: AdminPost[] }>>;
  get(id: string): Promise<ApiResult<{ post: AdminPost }>>;
  create(input: AdminPostInput): Promise<ApiResult<{ post: AdminPost }>>;
  update(id: string, input: AdminPostInput): Promise<ApiResult<{ post: AdminPost }>>;
  setStatus(id: string, status: AdminPostStatus): Promise<ApiResult<{ post: AdminPost }>>;
  remove(id: string): Promise<ApiResult<{ ok: boolean; removedReplies: number }>>;

  replies(
    postId: string,
    cursor: string,
  ): Promise<ApiResult<{ replies: AdminReply[]; nextCursor: string | null }>>;
  setReplyStatus(id: string, status: AdminReplyStatus): Promise<ApiResult<{ reply: AdminReply }>>;

  /** 上传正文插图，返回可直接写进 Markdown 的 URL。 */
  uploadMedia(file: File): Promise<ApiResult<SavedMedia>>;

  categories(): Promise<ApiResult<{ categories: AdminCategory[] }>>;
  createCategory(name: string): Promise<ApiResult<{ category: AdminCategory }>>;
  updateCategory(id: string, name: string): Promise<ApiResult<{ category: AdminCategory }>>;
  removeCategory(id: string): Promise<ApiResult<{ ok: boolean }>>;
  reorderCategories(ids: string[]): Promise<ApiResult<{ categories: AdminCategory[] }>>;
}

export const livePostsSource: PostsSource = {
  meta: fetchBlogMeta,
  list: fetchAdminPosts,
  get: fetchAdminPost,
  create: createAdminPost,
  update: updateAdminPost,
  setStatus: setAdminPostStatus,
  remove: deleteAdminPost,
  replies: fetchAdminReplies,
  setReplyStatus: setAdminReplyStatus,
  uploadMedia: uploadBlogMedia,
  categories: fetchAdminCategories,
  createCategory: createAdminCategory,
  updateCategory: updateAdminCategory,
  removeCategory: deleteAdminCategory,
  reorderCategories: reorderAdminCategories,
};
