/**
 * 「我的方式」板块（`.s-my-way`）的文案与对象数据。
 *
 * 这一段是参考站 wodniack.dev 的 `SMyWay` 段的移植——标题行 `Coding my way since 1987`
 * 就出自这里。结构与动画在 `scene/my-way.ts`，配色在 `styles.css` 的 `.s-my-way` 块。
 *
 * 之所以单独一个文件而不是继续挂在 `content/works.ts` 上：这一段在参考站里是**独立
 * 的一屏**（`SWork → SMyWay → SCTA`），它自己的一批常量跟 WORK 段的卡片数据没有关系，
 * 放在一起会让两段的作者互相踩。
 */

/**
 * 底部四行大字。
 *
 * 参考站写的是 `Coding / my way / since / 1987`（1987 是作者的出生年）。这里按本站自己的
 * 时间线写成 `Learning / my way / since / 2022`——**这是用户明确选定的值**，不是遗漏。
 */
export const MY_WAY_LINES: readonly string[] = ['Learning', 'my way', 'since', '2022'];

/** 板块的无障碍标题。 */
export const MY_WAY_SECTION_LABEL = '我的方式';

/** 星形对象数量（与参考站一致）。 */
export const MY_WAY_STAR_COUNT = 10;

/** 一个 3D 相框对象。 */
export interface MyWayFrame {
  /** 图注（相框底部那一行小字）。 */
  readonly caption: string;
  /**
   * 画面宽高比 = 宽 / 高。
   *
   * 参考站 16 张素材的比例各不相同（竖版 6、横版 7、方形 3），相框因此高度不一，
   * 飞过镜头时的遮挡关系才有节奏。数值逐张照抄参考站 `<img>` 上的 width/height。
   */
  readonly ratio: number;
  /** 真素材地址（相对站点根）。缺省时画占位面，换素材只补这一行。 */
  readonly src?: string;
}

/**
 * 16 个相框。
 *
 * 目前**全是占位**（用户选定的做法：先不接真图）：没有 `src` 时相框里画一块由主题色
 * 派生的版画，结构、动画、比例与真素材完全一致。以后拿到自己的照片，往
 * `apps/web/public/my-way/` 丢文件、在这里补一行 `src` 即可。
 */
export const MY_WAY_FRAMES: readonly MyWayFrame[] = [
  { caption: '占位作品 · 相框一', ratio: 1024 / 1024 },
  { caption: '占位作品 · 相框二', ratio: 760 / 1024 },
  { caption: '继续做点小东西', ratio: 802 / 1024 },
  { caption: '占位作品 · 相框四', ratio: 768 / 1024 },
  { caption: '占位作品 · 相框五', ratio: 600 / 600 },
  { caption: '占位作品 · 相框六', ratio: 768 / 1024 },
  { caption: '占位作品 · 相框七', ratio: 576 / 1024 },
  { caption: '继续做点小东西', ratio: 640 / 480 },
  { caption: '占位作品 · 相框九', ratio: 1024 / 576 },
  { caption: '占位作品 · 相框十', ratio: 1024 / 576 },
  { caption: '占位作品 · 相框十一', ratio: 1440 / 1440 },
  { caption: '占位作品 · 相框十二', ratio: 1024 / 768 },
  { caption: '继续做点小东西', ratio: 1024 / 767 },
  { caption: '占位作品 · 相框十四', ratio: 1024 / 768 },
  { caption: '占位作品 · 相框十五', ratio: 1024 / 768 },
  { caption: '占位作品 · 相框十六', ratio: 768 / 1024 },
];

/**
 * 相框素材目录（相对站点根）。
 *
 * 与 `MY_WAY_FRAMES[].src` 配合：`src` 里只写文件名时拼这个前缀更整齐。
 */
export const MY_WAY_ASSET_BASE = './my-way/';
