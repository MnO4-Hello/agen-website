/**
 * 「关于我」页的全部文案与地址。
 *
 * 单独成文件有两个理由：① 改字不用碰 DOM 代码；② 这一页的正文和首页「我是谁？」
 * （`content/profile.ts`）是**两份不同的稿子**——首页那段是宣言、要满足点阵动画的
 * 分段时间线，这一页是自述、可以自由长。所以刻意不合并，谁也别去「统一」它。
 */

/** 页头小标。和其它页一样是全大写拉丁字母，纯装饰。 */
export const ABOUT_KICKER = 'ABOUT';

export const ABOUT_TITLE = '关于我';

/** 标签页标题后缀，与 `content/message.ts` 的 `MESSAGE_TITLE_SUFFIX` 同款写法。 */
export const ABOUT_TITLE_SUFFIX = ' · 阿根';

/**
 * 页头右栏那句引子 = 正文第一段。
 *
 * 放在页头而不是正文里，是因为它自带「我是谁」的答案，读者扫一眼就够；后面四段
 * 才是展开。改文案时注意它还兼着「首屏唯一的长句子」，别写成两行以上。
 */
export const ABOUT_LEDE =
  '我是阿根，真名付硕（我不在乎）。最开始想叫“高锰酸根”，但实在不好写，就简化成了“阿根”。目前我还在读大学，学历不算亮眼，是一所普通民办本科——武汉晴川大学。很欢迎大家来找我玩（笑）。';

/** 其余四段（正文第 2–5 段），一段一个 `<p>`。 */
export const ABOUT_PARAGRAPHS: readonly string[] = [
  '武汉是个好地方，这也是我真正意义上第一次走出大山。这座城市的便利远超我的想象（当然，开销也远超我的想象）。我很希望将来能在这里安家，不过这都是后话了。',
  '现在，我在大学里的生活和学习都要花不少钱。事实上，我挺缺钱的，也在努力兼职，尽量做到经济独立。但生活很累，工作也很累，我不想就这样妥协，我想让自己更“不一样”一些。我很钦佩那些闪闪发光的人，也想成为他们那样的人；我想做一颗燃烧的星星，也在这片银河中留下一点光。',
  '我很早就想当一名创作者，但我不希望自己的作品为了迎合潮流而放弃自我。目前我也没有精力去创作一个足够惊艳的作品。思考、摸索了很多年，我想：“不如做个博客吧。”这大概是目前最适合我的方式。在这里没有多少观众，但我可以在自己创造的这一番天地里，尽情做自己。我们在这里相遇，而我仍然没有放弃自己的理想；我想在未来的某一天，我们会以不同的方式再次相遇。',
  '说实话，我的编程能力很烂。不过这些年AI发展非常迅速，借助AI的力量，我完成了这个博客。我想，以AI目前的发展速度，或许用不了十年，人类绝大部分工作都会被AI取代。我觉得自己很幸运，能亲眼见证一个新时代的到来。那我会担心未来被AI取代吗？我需要赚钱、需要养活自己，担心是肯定的；但比起担心，我更相信“生命总会找到出路”。更何况，我还有自己的理想在未来等着我。我不会拘泥于现在，也不会过分担心未来——“如果连自己的未来都不愿意相信，那未来又怎会变得更好呢？”就像我一直信奉的那四个字：未来可期。',
];

/**
 * 头像：与首页同一张插画、同一套两档图（`public/portrait-{512,1024}.png`）。
 *
 * 只描述「怎么取图」，不含 DOM——`pages/about.ts` 负责拼 `srcset`。之所以不在这里
 * 存整串 `srcset`，是因为前缀要和宽度列表配着改，合并成字段反而容易漏改一处。
 */
export const ABOUT_PORTRAIT = {
  /** 不带尺寸后缀的路径前缀（与 `sections/identity.ts` 的 `portraitSrc` 同约定）。 */
  base: './portrait',
  widths: [512, 1024],
  /** 左栏最宽 15rem，单列时不超过 12rem，两档都远小于 512，够用。 */
  sizes: '(max-width: 48rem) 45vw, 15rem',
  alt: '阿根的头像插画',
  caption: '高锰酸根 MnO₄⁻',
} as const;

export interface AboutContact {
  readonly id: 'qqzone' | 'bilibili' | 'github' | 'email';
  /** 胶囊上看得见的文字。**别往里塞完整邮箱**，37 个字符必然换行。 */
  readonly label: string;
  /** 完整地址或 `mailto:`。 */
  readonly href: string;
  /** 圆形徽标里的那一个字符（ASCII，`system-ui` 必有字形）。 */
  readonly glyph: string;
  /** true → 新标签页打开（加 `target` + `rel`）；false → 交给浏览器原生行为（mailto）。 */
  readonly external: boolean;
  /** `title` / `aria-label` 用的补充说明，读屏念出来比单个字母有用。 */
  readonly hint: string;
}

/** 关于页的邮箱，单独留一份给胶囊下面那行等宽小字（可选中复制）。 */
export const ABOUT_EMAIL = 'outlook_7D03F985F2370761@outlook.com';

export const ABOUT_CONTACT_TITLE = '联系我';

export const ABOUT_CONTACT_NOTE = '想聊天、想合作，或者只是路过打个招呼，都可以找我。';

/**
 * 顺序即视觉顺序：QQ 空间 → B 站 → GitHub → 邮箱。
 * B 站的 `spm_id_from` 是分享追踪参数，删掉后是干净的规范地址。
 */
export const ABOUT_CONTACTS: readonly AboutContact[] = [
  {
    id: 'qqzone',
    label: 'QQ 空间',
    href: 'https://user.qzone.qq.com/3194295857',
    glyph: 'Q',
    external: true,
    hint: 'QQ 空间',
  },
  {
    id: 'bilibili',
    label: 'B 站',
    href: 'https://space.bilibili.com/3546846853073758',
    glyph: 'B',
    external: true,
    hint: 'B 站个人空间：高锰酸根不无聊',
  },
  {
    id: 'github',
    label: 'GitHub',
    href: 'https://github.com/MnO4-Hello',
    glyph: 'G',
    external: true,
    hint: 'GitHub：MnO4_',
  },
  {
    id: 'email',
    label: 'Outlook 邮箱',
    href: `mailto:${ABOUT_EMAIL}`,
    glyph: '@',
    external: false,
    hint: '发邮件给阿根',
  },
];

/* ---------------------------------------------------------------------------
   赞助我（支付宝 / 微信收款码）
---------------------------------------------------------------------------

   历史：2026-10-27 这块曾被整块删掉——个人网站**备案期间**页面上摆收款码容易被认定成
   「经营性内容」，风险不值得冒，图也从 `public/images/` 删了。

   现在（2026-11-04）备案已通过：备案/许可证编号 鄂ICP备2026064077号，所以按站长的要求
   恢复。重申几条边界，改之前先读：

     · 只作**打赏**，不承诺任何回报、不卖东西、不开会员——一旦沾上交易属性，个人主体的
       备案就可能被判定不符（见 docs/DEPLOY.md 的「display 不是骗过审核」一节）；
     · 二维码是**纯静态图片**（`public/images/sponsor-*.png`，从站长给的原图裁出、
       只保留码本体 + 白边），页面不对接任何支付接口；
     · 要撤掉只需删掉下面的 `ABOUT_SPONSORS` 与 `pages/about.ts` 里那一处 append，
       不留别的耦合。

   以后若抽查认定不符，第一个该动的就是这一块。 */

export const ABOUT_SPONSOR_TITLE = '赞助我';

/** 引用站长原话；句末加句号，和 `.about__section-note` 其它几句保持一致。 */
export const ABOUT_SPONSOR_NOTE = '假如你喜欢我的话，可以请我喝一杯奶茶。';

export interface AboutSponsor {
  readonly id: 'alipay' | 'wechat';
  /** 胶囊上看得见的文字。 */
  readonly label: string;
  /** 圆形徽标里的那一个字符（ASCII/常用符号，`system-ui` 必有字形）。 */
  readonly glyph: string;
  /** 收款码图片（`public/images/` 下，绝对路径，和 styles.css 里的 mask 用法一致）。 */
  readonly qr: string;
  /** 图片的替代文字 / `title`。 */
  readonly hint: string;
}

/** 顺序即视觉顺序：蓝色支付宝 → 绿色微信。 */
export const ABOUT_SPONSORS: readonly AboutSponsor[] = [
  {
    id: 'alipay',
    label: '支付宝',
    glyph: '支',
    qr: '/images/sponsor-alipay.png',
    hint: '支付宝收款码',
  },
  {
    id: 'wechat',
    label: '微信',
    glyph: '✓',
    qr: '/images/sponsor-wechat.png',
    hint: '微信收款码',
  },
];
