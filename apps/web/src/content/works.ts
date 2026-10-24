/**
 * 「作品」板块的文案与卡片数据。
 *
 * 和 profile.ts / skills.ts 一样，把字与布局分开：换作品只改这里，不必碰动画代码。
 *
 * 参考站（wodniack.dev）的 WORK 段里，每一张卡片是一段静音循环的视频，图注格式为
 * `#3vva-0000/34`（前缀 + 四位序号 + 总数）。我们要求「先用占位卡片」，所以每条
 * 作品只声明标题、编号与一段可选素材路径：
 *   - 有 `src`（图片或视频，相对站点根）→ 卡片里显示它；
 *   - 没有 `src` → 卡片退化成一块由编号派生的占位面，结构、动画完全一致。
 * 以后拿到真素材，往 `apps/web/public/works/` 里丢文件、在这里补一行 `src` 即可。
 *
 * 卡片数量直接决定板块高度（每张 50lvh，与参考站一致：34 × 50lvh = 1700lvh）。
 */

/** 板块大字。参考站在标题与跑马灯两态之间切换，用的都是这四个字母。 */
export const WORKS_TITLE = 'WORK';

/** 「作品」板块的无障碍标题。 */
export const WORKS_SECTION_LABEL = '我的作品';

/** 本段右下角那枚「跳过」胶囊的可见文案。 */
export const WORK_SKIP_LABEL = '跳过';

/** 同上，读屏用的说明（胶囊上的「跳过」单独看没有主语）。 */
export const WORK_SKIP_HINT = '跳过作品展示，直接到结尾';

/** 图注编号前缀，最终形如 `#agen-0000/34`（参考站是 `#3vva-…`）。 */
export const WORK_CODE_PREFIX = 'agen';

/** 素材放置目录（相对站点根）。 */
export const WORK_ASSET_BASE = './works/';

/** 卡片总数——与参考站对齐的 34 张。 */
export const WORK_CARD_COUNT = 34;

/** 每张卡片占用的滚动行程（lvh）。50 与参考站一致。 */
export const WORK_LVH_PER_CARD = 50;

/**
 * 结尾区块里「相框」对象的图注与占位文案。
 *
 * 参考站有 14 个相框 + 10 个星形，这里用同样数量、但内容为占位——对象的摆放、
 * 物理、消散逻辑与真素材完全一致，换素材时只改这个数组。
 */
export const WORKS_FRAME_CAPTIONS: readonly string[] = [
  '占位作品 · 相框一',
  '占位作品 · 相框二',
  '继续做点小东西',
  '占位作品 · 相框四',
  '占位作品 · 相框五',
  '占位作品 · 相框六',
  '占位作品 · 相框七',
  '继续做点小东西',
  '占位作品 · 相框九',
  '占位作品 · 相框十',
  '占位作品 · 相框十一',
  '占位作品 · 相框十二',
  '继续做点小东西',
  '占位作品 · 相框十四',
];

/** 结尾区块里星形对象的数量（贴图缺省时用内联 SVG 占位）。 */
export const WORKS_STAR_COUNT = 10;

/**
 * 一张作品卡。
 *
 * `code` 会印在图注右半边（`#agen-0000/34` 里的 `0000`），不必手写，由数组下标补零。
 */
export interface WorkCardContent {
  /** 作品名，图注左半边。 */
  readonly title: string;
  /** 图注右半边的四位编号，例如 `'0000'`；由数组下标生成。 */
  readonly code: string;
  /** 点击卡片跳转的地址；没有则是不可点的展示卡。 */
  readonly href?: string;
  /**
   * 是否新标签打开。
   *
   * 缺省按地址判断（见 `scene/work-card.ts`）：`#` 开头算站内、同页跳转，其余算外链。
   * 显式给出这个字段是为了在「站内但想开新标签」这类边缘情况里不用再改默认逻辑。
   */
  readonly external?: boolean;
  /** 素材地址（相对站点根）；缺省则用编号派生的占位面。 */
  readonly src?: string;
  /** 素材是视频还是图片；缺省按扩展名猜。 */
  readonly media?: 'image' | 'video';
}

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 把阿拉伯数字转成中文读数，用于占位标题（34 → 「三十四」）。 */
const toChineseNumber = (value: number): string => {
  if (value < 10) return CHINESE_DIGITS[value] ?? String(value);
  if (value < 20) return value === 10 ? '十' : `十${CHINESE_DIGITS[value - 10] ?? ''}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${CHINESE_DIGITS[tens] ?? ''}十${ones === 0 ? '' : (CHINESE_DIGITS[ones] ?? '')}`;
};

/**
 * 作品列表（34 条占位）。
 *
 * 数量决定了板块高度（每张 50lvh）与卡片流水线的节拍。改 `title` / `code` / `src`
 * 即可变成真作品；`code` 也可以手写覆盖。
 */
export const WORK_CARDS: readonly WorkCardContent[] = Array.from(
  { length: WORK_CARD_COUNT },
  (_, index): WorkCardContent => ({
    title: `占位作品 · ${toChineseNumber(index + 1)}`,
    code: String(index).padStart(4, '0'),
  }),
);

/** `workCaptionKey` 的可选项。 */
export interface CaptionKeyOptions {
  /** 墙上总张数；首页接真实作品后会小于 34。 */
  readonly total?: number;
}

/**
 * 拼出图注右半边的完整编号，例如 `#agen-0000/34`。
 *
 * 第二个参数**刻意是对象而不是裸数字**：`Array.prototype.map` 会把下标当第二参传进来，
 * 写成数字签名的话 `WORK_CARDS.map(workCaptionKey)` 会悄悄变成「分母 = 下标」
 * （第 0 张显示 `/0`、第 33 张显示 `/33`）。对象签名让这种误用在 TS 里直接报错。
 */
export const workCaptionKey = (card: WorkCardContent, options: CaptionKeyOptions = {}): string => {
  const total = options.total && options.total > 0 ? options.total : WORK_CARD_COUNT;
  return `#${WORK_CODE_PREFIX}-${card.code}/${total}`;
};
