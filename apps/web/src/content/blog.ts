/**
 * 博客 / 社区的文案。
 *
 * 与 `content/works.ts` 同一考虑：这里只放「会被人读到、且可能想改」的字；纯结构性的
 * 标签（`#`、`赞同`）就近写在组件里，集中到这儿反而找不到。
 */

export const BLOG_COPY = {
  kicker: 'BLOG',
  title: '社区',
  /** 列表页副标题：把「这里能干什么」说清楚，比一句「最新文章」有用。 */
  intro: '写长的想清楚，写短的聊起来。帖子由站长发布，回复登录或免登录都行。',

  searchLabel: '搜索帖子',
  searchPlaceholder: '搜标题、正文或标签…',
  searchClear: '清除搜索',

  allCategories: '全部',
  tagPrefix: '标签',
  clearTag: '取消标签筛选',
  reset: '重置筛选',

  sortNew: '最新',
  sortHot: '最热',

  loading: '正在读取帖子…',
  loadMore: '加载更多',
  loadMoreLoading: '正在加载…',
  loadMoreError: '没加载出来，再试一次',
  retry: '重试',

  emptyLibrary: '还没有帖子。等站长写完第一篇，这里就热闹了。',
  emptyFiltered: '没有匹配的帖子，换个关键词或分类试试。',
  error: '读取帖子失败。',

  repliesTitle: '回复',
  repliesEmpty: '还没有回复，坐下来聊两句？',
  replyLocked: '这篇帖子的回复已经关闭了。',
  replyDeleted: '该回复已删除',
  replyPlaceholder: '写点你的看法…（纯文本，换行会保留）',
  replySubmit: '发表回复',
  replySubmitting: '正在发送…',
  replyGuestNotice: '免登录回复：昵称统一显示为「游客」，验证会在你打字时自动完成。',
  replyLoginNotice: '你已登录，回复会带上你的昵称与头像。',
  replyQuoteTo: '回复',
  replyCancelQuote: '取消引用',
  replyTooShort: '至少写两个字。',
  replyPosted: '发布成功。',

  verifyWorking: '人机验证中…',
  verifyDone: '人机验证通过',
  verifyFailed: '验证没完成，点「重试」再来一次',
  verifyRetry: '重试',
  verifyBlocked: '人机验证还没完成，稍等一下再提交。',

  voteUp: '赞同',
  voteDown: '反对',
  voteLoginHint: '登录后才能投票',
  voteFailed: '投票没成功，稍后再试。',

  missing: '没有这篇帖子，可能已经被删掉了。',
  backToList: '回到列表',
  detailError: '读取这篇帖子失败。',
} as const;

/** 详情页标签页的标题后缀。 */
export const BLOG_TITLE_SUFFIX = ' · 阿根';
