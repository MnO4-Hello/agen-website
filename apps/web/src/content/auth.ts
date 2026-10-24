/**
 * 账号相关的一切文案：登录 / 注册表单、导航栏账号菜单、个人中心占位页，
 * 以及《用户协议》《隐私政策》的正文。
 *
 * 与 `content/` 下其它文件同一约定：**只导出只读常量与类型，不碰 DOM**。
 * 正文用结构化数据（section / paragraph 数组）而不是 HTML 字符串——渲染时一律
 * `textContent`，谁也没机会把一段用户可编辑的内容变成 `<script>`。
 *
 * ⚠️ 下面两份条款是**示例文本**，按本站实际情况写成，但正式对外之前请自己再过一遍
 *    （尤其是联系邮箱与"删除账号"的处理方式）。
 */

import type { Role } from '../auth/api';

/* ---------------------------------------------------------------------------
   条款正文
--------------------------------------------------------------------------- */

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface LegalDoc {
  readonly title: string;
  readonly updatedAt: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

export const TERMS: LegalDoc = {
  title: '用户协议',
  updatedAt: '2026-10-23',
  intro: '在你注册账号之前，请花两分钟读完下面这几段。继续注册并使用本站，即表示你接受本协议。',
  sections: [
    {
      heading: '一、这份协议管什么',
      paragraphs: [
        '本协议适用于你在本站注册账号、登录以及使用账号相关功能的全部行为。本站是个人站点，不是商业平台，提供服务的目的主要是让作品集与留言有一个可识别的身份。',
      ],
    },
    {
      heading: '二、账号与身份',
      paragraphs: [
        '注册时你需要填写用户名、昵称、邮箱和密码。其中「用户名」只用于登录，不会对外展示；「昵称」才是别人看到的名字。',
        '一个邮箱只能注册一个账号。账号仅限你本人使用，请不要转让、出借或出售。',
        '邮箱目前只做登记，没有验证码校验。如果邮箱填错了，密码将无法找回——请填一个你确实在用的邮箱。',
      ],
    },
    {
      heading: '三、你承诺不做的事',
      paragraphs: [
        '不使用他人身份或容易引起误解的昵称（例如冒充站长、管理员）。',
        '不发布违法、侵权、侮辱、骚扰或广告性质的内容。',
        '不以任何方式尝试绕过登录限制、攻击站点、批量注册或抓取数据。',
      ],
    },
    {
      heading: '四、内容与版权',
      paragraphs: [
        '本站的文章、作品、图片与代码，除特别注明外版权归站长所有，转载前请先联系。',
        '你在留言等位置发布的内容仍归你所有，但你授权本站将其展示在页面上。',
      ],
    },
    {
      heading: '五、关于停用账号',
      paragraphs: [
        '如果账号违反本协议，我们可以在不事先通知的情况下停用或删除该账号。',
        '你也可以随时联系站长要求删除自己的账号，删除后用户名与昵称会被释放。',
      ],
    },
    {
      heading: '六、服务按现状提供',
      paragraphs: [
        '本站是个人维护的站点，可能因为维护、迁移或故障而暂时不可用，也可能出现数据丢失。请自行备份你发布的重要内容。',
        '对于因使用或无法使用本站而产生的损失，本站不承担责任，法律另有规定的除外。',
      ],
    },
    {
      heading: '七、协议变更与联系方式',
      paragraphs: [
        '本协议可能会随功能调整而更新，更新后会修改本页顶部的日期。继续使用即视为接受更新后的版本。',
        '有疑问可以发邮件到 3194295857@qq.com。',
      ],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  title: '隐私政策',
  updatedAt: '2026-10-23',
  intro: '这份政策说明本站收集哪些信息、为什么收集，以及你能要求我们做什么。',
  sections: [
    {
      heading: '一、我们收集哪些信息',
      paragraphs: [
        '注册时你主动填写的内容：用户名、昵称、邮箱、密码。密码不会以明文保存，只保存不可逆的哈希值。',
        '系统自动记录的内容：注册时间、最后登录时间。',
        '我们不收集手机号、身份证号、精确位置，也不接入任何第三方统计或广告脚本。',
      ],
    },
    {
      heading: '二、这些信息用来做什么',
      paragraphs: [
        '用户名或邮箱：识别你的身份，让你能登录。',
        '昵称：在页面上展示你的名字。',
        '邮箱：目前仅作登记，用于你日后找回账号时核对身份；本站不会给你发营销邮件。',
      ],
    },
    {
      heading: '三、Cookie',
      paragraphs: [
        '登录成功后，服务器会写入一枚名为 agen_user 的会话 Cookie。它是 HttpOnly 的，页面脚本读不到，内容只有「你是谁」和「什么时候过期」，不含密码。',
        '退出登录会立即清除这枚 Cookie。除此之外本站不使用任何跟踪类 Cookie。',
      ],
    },
    {
      heading: '四、我们怎么保护它',
      paragraphs: [
        '密码使用 scrypt 加盐哈希后保存，即使数据文件被拿走也无法直接还原密码。',
        '账号数据保存在本站服务器的数据文件中，只有站长有访问权限。',
        '需要说明的是：没有任何系统能保证绝对安全。请不要在多个网站复用同一个密码。',
      ],
    },
    {
      heading: '五、我们不会做的事',
      paragraphs: [
        '不出售、不出租你的个人信息。',
        '不把邮箱提供给任何第三方用于推广。',
        '除法律法规要求或你本人同意外，不向第三方披露你的信息。',
      ],
    },
    {
      heading: '六、你可以要求什么',
      paragraphs: [
        '你可以要求查询、更正或删除你的账号与相关信息。',
        '删除账号后，用户名与昵称会被释放，相关记录会从数据文件中移除。',
        '联系方式：3194295857@qq.com。',
      ],
    },
    {
      heading: '七、未成年人',
      paragraphs: [
        '如果你未满 14 周岁，请在监护人陪同下阅读本政策，并在取得同意后再注册。',
      ],
    },
    {
      heading: '八、政策变更',
      paragraphs: [
        '本政策更新后会修改本页顶部的日期。涉及收集范围的重大变化，会在站点上单独提示。',
      ],
    },
  ],
};

/* ---------------------------------------------------------------------------
   导航栏账号位
--------------------------------------------------------------------------- */

export const ROLE_LABEL: Record<Role, string> = {
  user: '普通用户',
  admin: '管理员',
  owner: '站长',
};

export const ACCOUNT_ENTRY_COPY = {
  login: '登录',
  register: '注册',
  menuLabel: '账号菜单',
  logout: '退出登录',
  admin: '管理员后台',
} as const;

export interface AccountMenuItem {
  readonly id: 'profile' | 'home' | 'settings' | 'admin';
  readonly label: string;
  /** `null` = 不是站内路由（外链，例如 `/admin.html`）。 */
  readonly href: string | null;
  readonly adminOnly?: boolean;
}

export const ACCOUNT_MENU: readonly AccountMenuItem[] = [
  { id: 'profile', label: '个人中心', href: '#account/profile' },
  { id: 'home', label: '我的主页', href: '#account/home' },
  { id: 'settings', label: '设置', href: '#account/settings' },
  { id: 'admin', label: '管理员后台', href: '/admin.html', adminOnly: true },
];

/* ---------------------------------------------------------------------------
   登录 / 注册页
--------------------------------------------------------------------------- */

export const AUTH_PAGE_COPY = {
  eyebrow: '账号',
  asideTitle: '留个名字，\n下次就不用重新介绍自己。',
  asideNote: '注册只需要用户名、昵称、邮箱和密码。邮箱暂不做验证，只作登记。',
  tabLogin: '登录',
  tabRegister: '注册',
  loginTitle: '欢迎回来',
  loginNote: '用户名和邮箱都能用来登录。',
  registerTitle: '创建一个账号',
  registerNote: '四个字段，一条协议，然后就能留言了。',
  identifier: '账号',
  identifierHint: '用户名或邮箱',
  username: '用户名',
  /** 括号里的这句是产品要求：必须让人一眼看懂「用户名不对外展示」。 */
  usernameHint: '只用于登录，不对外展示（别人看到的是昵称）',
  nickname: '昵称',
  email: '邮箱',
  emailHint: '只做登记，不发验证码',
  password: '密码',
  confirmPassword: '确认密码',
  submitLogin: '登录',
  submitRegister: '注册并登录',
  submitting: '请稍候…',
  switchToRegister: '还没有账号？',
  switchToRegisterAction: '去注册',
  switchToLogin: '已经有账号了？',
  switchToLoginAction: '去登录',
  agreedPrefix: '我已阅读并同意',
  termsLabel: '《用户协议》',
  agreedAnd: '和',
  privacyLabel: '《隐私政策》',
  legalBack: '返回',
  legalUpdated: '更新于',
  signedIn: '你已经登录了',
  signedInHint: '要换个账号，先退出当前账号。',
  goAccount: '去个人中心',
  logout: '退出登录',
  sessionExpired: '登录状态已失效，请重新登录。',
} as const;

/* ---------------------------------------------------------------------------
   个人中心（占位页）
--------------------------------------------------------------------------- */

export interface AccountTabCopy {
  readonly title: string;
  readonly note: string;
}

export const ACCOUNT_TAB_COPY: Record<'profile' | 'home' | 'settings', AccountTabCopy> = {
  profile: {
    title: '个人中心',
    note: '这一页已经把账号资料接上了；改昵称、换头像、改密码还在做。',
  },
  home: {
    title: '我的主页',
    note: '这里以后会是你的个人主页：留言、作品、收藏。现在还是空的。',
  },
  settings: {
    title: '设置',
    note: '通知、隐私、第三方账号绑定都会放在这里。现在还是占位页。',
  },
};

export const ACCOUNT_TABS: readonly { id: 'profile' | 'home' | 'settings'; label: string }[] = [
  { id: 'profile', label: '个人中心' },
  { id: 'home', label: '我的主页' },
  { id: 'settings', label: '设置' },
];

export const ACCOUNT_GUEST_COPY = {
  title: '请先登录',
  note: '这个页面需要账号才能看。登录之后就会自动回到这里。',
  action: '去登录',
} as const;

export const ACCOUNT_PROFILE_LABELS = {
  nickname: '昵称',
  username: '用户名',
  email: '邮箱',
  role: '身份',
  createdAt: '注册时间',
  usernameNote: '只用于登录，不对外展示',
} as const;
