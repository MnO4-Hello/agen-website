/**
 * 个人中心与公开主页的全部文案。
 *
 * 与其他 `content/*` 一样：**只导出只读常量与类型，不碰 DOM**。好处是改一句话
 * 不用翻组件，坏处是要多跳一个文件——对文案密度这么高的页面，前者更值。
 */

import type { Gender, PrivacyLevel, ProfileField, ProfileVisibility } from '../account/types';

export const ACCOUNT_TAB_COPY = {
  profile: {
    title: '个人中心',
    note: '这一页是你账号的样子。想改资料就切到「设置」，改完这里会立刻更新。',
  },
  home: {
    title: '我的主页',
    note: '这是别人打开你的链接时会看到的页面。左边可以切到「游客视角」看看隐藏了什么。',
  },
  settings: {
    title: '设置',
    note: '左边六个分区分别管资料、安全、外观、徽章、链接与隐私。改完记得点右下角的保存。',
  },
} as const;

export const ACCOUNT_EMPTY_COPY = {
  loading: '正在读取资料…',
  guestTitle: '请先登录',
  guestNote: '这个页面需要账号才能看。登录之后就会自动回到这里。',
  guestAction: '去登录',
  failedTitle: '资料没能读出来',
  failedAction: '重试',
  /** 头部右上角：跳到自己的公开主页（`#u/<用户名>`）。 */
  publicAction: '查看公开主页',
} as const;

/* ---------------------------------------------------------------------------
   资料
--------------------------------------------------------------------------- */

export const IDENTITY_COPY = {
  title: '基本资料',
  note: '昵称与头像是必显的——它们是「这是谁」的最低信息。',
  nickname: '昵称',
  nicknameHint: '1–24 个字符，全站唯一（不区分大小写）。',
  email: '邮箱',
  emailHint: '改邮箱要输入当前密码。',
  signature: '一句话签名',
  signatureHint: '显示在昵称下面，最多 40 个字。',
  bio: '简介',
  bioHint: '最多 300 字，支持换行。',
  gender: '性别',
  birthday: '生日',
  region: '地区',
  regionHint: '随便写，比如「杭州」或「在地球」。',
  currentPassword: '当前密码',
  currentPasswordHint: '只改邮箱时才需要填。',
  avatar: '头像',
  avatarHint: 'PNG / JPEG / WebP / GIF / AVIF，最多 8MB。',
  avatarUpload: '换一张',
  avatarRemove: '移除',
} as const;

export const GENDER_LABEL: Record<Gender, string> = {
  none: '不填',
  male: '男',
  female: '女',
  other: '其它',
};

export const SECURITY_COPY = {
  title: '账号安全',
  note: '改完密码不会把其他设备踢下线——它们各自持有的登录凭据仍然有效。',
  current: '当前密码',
  next: '新密码',
  nextHint: '8–16 位，必须同时包含字母和数字。',
  confirm: '确认新密码',
  submit: '更新密码',
} as const;

/* ---------------------------------------------------------------------------
   外观
--------------------------------------------------------------------------- */

export const APPEARANCE_COPY = {
  title: '外观',
  note: '这些只影响你的主页（#u/你的用户名），不会改动站点的其它页面。',
  cover: '主页横幅',
  coverHint: '建议 3:1 的横图，居中裁切。',
  background: '背景图',
  backgroundHint: '铺满整页，会被主题底色压住一半透明度——所以别用它放重要信息。',
  theme: '主题配色',
  themeHint2: '四个颜色分别对应按钮、深色文字、页面底色与正文。',
  themePresets: '预设',
  customTheme: '自定义',
  accent: '主色',
  accentStrong: '深主色',
  surface: '底色',
  text: '正文色',
  resetTheme: '恢复站点配色',
  css: '自定义 CSS',
  cssHint:
    '只作用于你的主页，会自动加作用域前缀。写错了不会报错，只是那条规则不生效。',
  cssNote:
    '不支持 @import / @font-face / url() —— 图片请用上面的上传。body、html、:root 选择器不生效，底色请用主题配色。',
  cssFormat: '整理格式',
  cssBytes: '字节',
} as const;

export const VISIBILITY_OPTIONS: readonly {
  value: ProfileVisibility;
  label: string;
  note: string;
}[] = [
  { value: 'public', label: '所有人可见', note: '游客拿着链接就能看，适合分享出去。' },
  { value: 'members', label: '仅登录用户', note: '未登录的人会看到「登录后可见」。' },
  { value: 'private', label: '只有我自己', note: '对外与「这个人不存在」完全一样。' },
];

/* ---------------------------------------------------------------------------
   徽章与标签
--------------------------------------------------------------------------- */

export const BADGES_COPY = {
  title: '徽章与标签',
  note: '标签是自由文本，徽章可以自己造——但名字不能碰「官方 / 认证」这类保留词。',
  systemTitle: '系统徽章',
  systemNote: '由账号信息自动生成，不能自己造，也不能关掉。',
  customTitle: '我自己的徽章',
  customNote: '最多 12 枚。名称 12 个字以内，颜色取 #rrggbb。',
  badgeName: '名称',
  badgeEmoji: '图标',
  badgeEmojiHint: '一个 emoji，可以不填。',
  badgeColor: '颜色',
  badgeAdd: '加一枚',
  tagsTitle: '标签',
  tagsHint: '最多 8 个，每个 16 个字以内。回车确认，点 × 删除。',
  tagPlaceholder: '输入后回车，比如 Python',
} as const;

export const LINKS_COPY = {
  title: '社交链接',
  note: '最多 6 条，只支持 http / https 地址。',
  label: '名称',
  labelPlaceholder: '比如 GitHub',
  url: '地址',
  urlPlaceholder: 'https://github.com/you',
  add: '加一条',
  empty: '还没有链接。',
} as const;

/* ---------------------------------------------------------------------------
   隐私
--------------------------------------------------------------------------- */

export const PRIVACY_COPY = {
  title: '隐私',
  note: '每一项都能单独设成「公开 / 仅自己 / 完全隐藏」。被隐藏的字段在别人看来和「没填」一模一样。',
  requiredTitle: '必显项',
  requiredNote: '昵称、头像、用户名。用户名还是你主页地址的一部分，藏起来没有意义。',
  visibilityTitle: '谁能看这个主页',
  lastLogin: '最后登录时间',
  signature: '一句话签名',
  bio: '简介',
  gender: '性别',
  birthday: '生日',
  region: '地区',
  socials: '社交链接',
  tags: '标签',
  badges: '徽章',
} as const;

export const PRIVACY_LEVEL_LABEL: Record<PrivacyLevel, string> = {
  public: '公开',
  self: '仅自己',
  hidden: '隐藏',
};

export const PRIVACY_LEVEL_NOTE: Record<PrivacyLevel, string> = {
  public: '谁都能看到',
  self: '只有你登录后能看到',
  hidden: '对所有人都不显示',
};

/** 隐私面板里的顺序与分组；`required` 那几项没有控件，只是说明。 */
export const PRIVACY_ORDER: readonly ProfileField[] = [
  'signature',
  'bio',
  'gender',
  'birthday',
  'region',
  'socials',
  'tags',
  'badges',
  'lastLogin',
];

/* ---------------------------------------------------------------------------
   公开主页
--------------------------------------------------------------------------- */

export const PUBLIC_PROFILE_COPY = {
  missingTitle: '没有这个人',
  missingNote: '链接可能拼错了，或者这个账号已经不存在。',
  missingAction: '回首页',
  loginTitle: '这个主页只对登录用户开放',
  loginNote: '登录之后就能看了，登录完会自动回到这里。',
  loginAction: '去登录',
  errorTitle: '主页没能读出来',
  errorAction: '重试',
  selfAction: '编辑我的主页',
  share: '复制链接',
  shareDone: '链接已复制',
  statDays: '天',
  statDaysLabel: '加入',
  statBadgesLabel: '徽章',
  statTagsLabel: '标签',
  sectionBio: '简介',
  sectionTags: '标签',
  sectionBadges: '徽章',
  sectionLinks: '找到我',
  sectionFacts: '资料',
  empty: '这里还是空的。',
  joined: '加入于',
  lastLogin: '最后登录',
  region: '地区',
  birthday: '生日',
  gender: '性别',
  hiddenNote: '这个人的主页不公开。',
} as const;

export const SETTINGS_SECTIONS = [
  { id: 'identity', label: '资料' },
  { id: 'security', label: '账号安全' },
  { id: 'appearance', label: '外观' },
  { id: 'badges', label: '徽章与标签' },
  { id: 'links', label: '社交链接' },
  { id: 'privacy', label: '隐私' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const SAVE_COPY = {
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  clean: '没有改动',
  dirty: '有改动还没保存',
  leaveConfirm: '设置还没保存，确定离开吗？',
  staleNote: '这个页面上的资料已经过期了（可能有另一个标签页改过），请刷新后再改。',
} as const;

/** 公开主页上「资料」一栏的字段顺序（值为 null 的直接跳过）。 */
export const PUBLIC_FACT_ORDER = ['region', 'gender', 'birthday', 'joined', 'lastLogin'] as const;

/** 与 `content/auth.ts` 的 `ROLE_LABEL` 重复是刻意的：这两个模块不该互相 import 文案。 */
export const ROLE_TAG_LABEL = {
  owner: '站长',
  admin: '管理员',
  user: '普通用户',
} as const;
