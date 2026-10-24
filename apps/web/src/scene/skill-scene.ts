/**
 * 右栏「场景」的统一契约。
 *
 * 「我会什么？」右栏原本只有两态：粒子团 ↔ 多图对比。现在把它泛化成任意多个
 * 场景：每个场景是一个「带句柄的视觉场」（和 image-compare / swarm-field 同源），
 * 由 `sections/skills.ts` 里的一张注册表按 id 惰性创建，卡片通过 `SkillCardContent.scene`
 * 声明自己要挂哪个场景。
 *
 * 把契约单独拆一个文件、而不是写在 section 里，是为了让场景模块（scene/*）不必反向
 * 依赖 section，也方便并发开发时「各加一个场景文件 + 各自在注册表加一行」而互不打架。
 *
 * 依赖方向：content/skills.ts（无依赖）← 本文件 ← scene/*.ts ← sections/skills.ts。
 */

import type { SkillCardContent } from '../content/skills';

export interface SkillSceneHandle {
  /** 根元素（例如 `.psbulb`、`.compare`），由编排层负责 show / hide。 */
  readonly element: HTMLElement;
  /** 淡入：一般写 `opacity` + 加 `.is-visible`。 */
  show(): void;
  /** 淡出：把根元素收回透明。**不停脚本**（由编排层调 `cancel`）。 */
  hide(): void;
  /** 播放一次脚本动画。`content` 是该卡的完整内容，供场景读取自身配置。 */
  play(content: SkillCardContent): void;
  /** 中止正在播放的脚本动画；保留当前视觉，不强制复位。 */
  cancel(): void;
  /** 卸载：移除监听、取消 rAF、把根元素从宿主里摘掉。 */
  dispose(): void;
}

/** 场景工厂：拿到挂载宿主与该卡内容，造出一个可用的场景。 */
export type SkillSceneFactory = (host: HTMLElement, content: SkillCardContent) => SkillSceneHandle;

/**
 * 兜底场景：未知 / 尚未注册的 id 用它顶上——存在但永远不显示、不吃事件。
 *
 * 为什么需要：并发开发时，某个卡片可能先声明了 `scene: 'xxx'` 而对应场景还没合进来，
 * 或者 id 拼错。此时应该「安静地什么都不做」，而不是抛错把整个板块带崩。
 */
export function inertSkillScene(): SkillSceneHandle {
  const element = document.createElement('div');
  element.className = 'skill-scene--inert';
  element.setAttribute('aria-hidden', 'true');
  element.style.display = 'none';
  return {
    element,
    show: () => {},
    hide: () => {},
    play: () => {},
    cancel: () => {},
    dispose: () => {
      element.remove();
    },
  };
}
