/**
 * 「Let's Rock」CTA 段 + 页脚的字面内容（对应参考站 wodniack.dev 的
 * `section.s-cta` 与 `footer.site-foot`）。
 *
 * 两条容易踩的坑，都写在这里免得散到别处：
 *
 *   ① 两行大字的每一个字都要拆成一个 `.s__cta__char`，CSS 靠
 *      `.s__cta__char:nth-child(1..5) { --delay: 0.1s…0.5s }` 拉开错峰阶梯。
 *      所以**每一行的字数都要落在梯子里**：当前是上行 2 字、下行 5 字，
 *      正好用满 1~5 档；字数一变就得回 `styles.css` 补一档或删一档。
 *   ② `CtaGlyph.sup` 是「贴在字形右上角的上标」，**不占独立字符位**——参考站用它装
 *      `Let's` 的撇号（`.sup { font-size: .5em; vertical-align: top }`）。本项目的
 *      文案里暂时没有竖排不了的上标，字段留着备用（`cta-stage.ts` 仍支持它）。
 */

/** 一个可见字形；`sup` 是贴在它右上角的上标。 */
export interface CtaGlyph {
  readonly char: string;
  readonly sup?: string;
}

/** 圆盘上方那行。 */
export const CTA_HEADLINE_TOP: readonly CtaGlyph[] = [{ char: '阿' }, { char: '根' }];

/**
 * 圆盘下方那行。
 *
 * 特意用小写 `n`：这一行在 `styles.css` 里覆写了 `text-transform: none`（圆盘默认
 * 全大写），所以按这里写下的样子显示——化学式的 `Mn` 不能变成 `MN`。
 */
export const CTA_HEADLINE_BOTTOM: readonly CtaGlyph[] = [
  { char: 'M' },
  { char: 'n' },
  { char: 'O' },
  { char: '4' },
  { char: '_' },
];

/** 圆盘中心的按钮文字（参考站 "GO"）。 */
export const CTA_BUTTON_LABEL = 'GO';

/**
 * 圆盘展开后那枚链接的地址，同时也是**页脚那颗「回到顶部」胶囊**之外唯一的联系方式。
 *
 * 参考站是 Cloudflare 混淆过的 `mailto:`。这里是**占位地址**（`example.com` 是 RFC 2606
 * 保留域名，永远不解析），换成本站真实邮箱只改这一行——
 * GO 按钮与底下那行小字**共用这一个常量**，别在别处再写一遍字面量。
 */
export const CTA_EMAIL = 'hello@example.com';

/**
 * 该 section 的无障碍名字。
 *
 * 参考站这一屏只有图形与大字，没有任何可供读屏识别的标题；给它一个 `aria-label`
 * 比硬塞一个视觉隐藏的 `<h2>` 更省事，也不会影响那条 55rem 的留白节奏。
 */
export const CTA_SECTION_LABEL = '联系方式';

/**
 * 页脚胶囊**悬停后**显示的两个字，同时用作它的 `aria-label`。
 *
 * 静止态写的是「回到顶部」（`FOOTER_PILL_LABEL`）——那是它的功能，第一眼要读得懂；
 * 悬停时才翻出品牌名。
 */
export const FOOTER_MARK_LABEL = '阿根';

/** 页脚胶囊**静止态**的文案（它的功能就是回到页面顶部）。 */
export const FOOTER_PILL_LABEL = '回到顶部';
