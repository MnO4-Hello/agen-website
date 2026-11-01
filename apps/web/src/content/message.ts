/**
 * 留言板的文案。
 *
 * 与 `content/blog.ts` 同一考虑：这里只放「会被人读到、且可能想改」的字；纯结构性的
 * 标签（`#`、`×`）就近写在组件里，集中到这儿反而找不到。
 */

export const MESSAGE_COPY = {
  kicker: 'GUESTBOOK',
  title: '留言',
  /** 副标题：把「这里能干什么、怎么发」说清楚，比一句「欢迎留言」有用。 */
  intro: '想说什么就写下来。登录后直接发，游客过一次人机验证就行；带图也可以。',

  statMessages: '条留言',
  statReplies: '条回复',

  loading: '正在读取留言…',
  empty: '还没有人留言。第一个说话的就是你。',
  error: '读取留言失败。',
  retry: '重试',
  loadMore: '加载更早的留言',
  loadMoreLoading: '正在加载…',
  loadMoreError: '没加载出来，再试一次',

  /* 编辑器 */
  modeText: '简单',
  modeMarkdown: 'Markdown',
  editTab: '编辑',
  previewTab: '预览',
  placeholderText: '写点想说的话…（换行会保留；也可以只发图片）',
  placeholderMarkdown: '支持 Markdown：# 标题、**加粗**、列表、引用、代码块、链接。',
  markdownHint: '图片请用工具栏的「插入图片」上传，站外图会显示成链接。',

  toolBold: '加粗',
  toolQuote: '引用',
  toolCode: '代码',
  toolLink: '链接',
  toolImage: '插入图片',

  imageAdd: '添加图片',
  imageUploading: '上传中…',
  imageFailed: '没传上，点掉重试',
  imageTooBig: '图片太大了（上限 5 MB）。',
  imageBadType: '只支持 PNG / JPEG / WebP / GIF / AVIF。',
  imageLimit: '最多 4 张图。',

  submit: '发布留言',
  submitReply: '发表回复',
  submitting: '正在发送…',
  guestNotice: '免登录留言：昵称显示为「游客」，人机验证会在你打字时自动完成。',
  quoteTo: '回复',
  cancelQuote: '取消引用',
  tooShort: '至少写两个字，或者放一张图。',
  posted: '发布成功。',
  replyPosted: '回复成功。',

  /* 卡片 */
  ownerBadge: '站长',
  markdownBadge: 'Markdown',
  deleted: '该留言已删除',
  floorPrefix: '#',
  replyAction: '回复',
  expandReplies: '展开',
  collapseReplies: '收起',
  replyUnit: '条回复',
  replyUnitOther: '条其他回复',

  /* 人机验证 */
  verifyWorking: '人机验证中…',
  verifyDone: '人机验证通过',
  verifyFailed: '验证没完成，点「重试」再来一次',
  verifyRetry: '重试',
  verifyBlocked: '人机验证还没完成，稍等一下再提交。',

} as const;

/** 页面标题后缀（与博客、作品保持同一种写法）。 */
export const MESSAGE_TITLE_SUFFIX = ' · 阿根';
