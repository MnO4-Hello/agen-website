/**
 * Copy for the personal sections, kept apart from the layout code so wording can
 * be edited without touching behaviour.
 */

/** Heading for the section. */
export const PROFILE_TITLE = '我是谁？';

/** Caption printed under the portrait. */
export const PROFILE_CAPTION = '高锰酸根 MnO₄⁻';

/**
 * The paragraph shown in the section, one line per paragraph block. The line
 * breaks are intentional: they are what the canvas lays out, so moving a
 * sentence should happen here rather than in the layout code.
 *
 * 段落数与每段的字数是排版输入（画布按段换行、时间线按总字数算），
 * 改文案时尽量保持 7 段、每段长度接近，否则 `identity` 的节奏会变。
 */
export const PROFILE_TEXT = [
  '我是阿根，全名是高锰酸根（MnO₄⁻）。我不太擅长起名字，但一来二去，倒觉得这名字挺合我意。',
  '我是一名大学生，在武汉晴川学院读书。令我苦恼的是，我的英语不太好；不过我会一直努力学下去，因为我真的很喜欢英语这门语言。',
  '我是个理想主义者。我喜欢绿色，喜欢星星，最喜欢《罗小黑战记》。我喜欢它们安静的模样——只是安静地存在着，不需要向谁证明什么。',
  '以前，我总坐在台下，看着别人发光，看着别人被掌声包围。我坐在角落里，觉得那样也挺好。我习惯了当观众，习惯了自己是那个“还行”的人。',
  '但最近，总有个念头冒出来——我也想试试。不是为了证明什么，只是觉得，我好像也可以。',
  '哪怕只有一点光，哪怕那点光只有自己看得见。',
  '慢慢来吧。未来可期，这就是我。',
].join('\n');
