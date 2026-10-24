/**
 * GSAP 的唯一注册点。
 *
 * 插件只需注册一次；集中在这里可以保证「先注册、后 import 使用者」的顺序，
 * 也避免各处重复 `registerPlugin` 造成 tree-shaking 判断分裂。
 *
 * 用到的东西：
 *   - `ScrollTrigger`：参考站 WORK 段的滚动时间轴（`scrub: 1`）靠它。
 *   - `EasePack` 提供 `SlowMo`——卡片错峰流水线用的 `slow(0.15, 0.6)`。
 *
 * ⚠️ **别用字符串 `'slow(0.15, 0.6)'`**。参考站的压缩代码里写的是这个字符串，看起来
 * 可以直接抄，但在 GSAP 3.15 的 ESM 构建里它**解析不出来**：
 *
 *   gsap.parseEase('slow')            → UNDEFINED
 *   gsap.parseEase('slow(0.15, 0.6)') → UNDEFINED
 *
 * 原因是 `EasePack` 把 `register = _initCore` 挂在了 `SlowMo` / `RoughEase` /
 * `ExpoScaleEase` 这三个**成员**上，而不是 `EasePack` 这个对象本身，所以
 * `registerPlugin(EasePack)` 什么也没登记（`EasePack.name`/`EasePack.register` 都不存在）。
 * 结果是字符串缓动被静默忽略，GSAP 退回到默认的 `power1.out`——卡片会「冲过去」而不是
 * 「慢悠悠地掠过中间」，观感差很多，且没有任何报错提示。
 *
 * 这里改成**直接传配置好的缓动函数**：语义和参考站一致，但不依赖字符串解析。
 */

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { EasePack, SlowMo } from 'gsap/EasePack';

gsap.registerPlugin(ScrollTrigger, EasePack);

/**
 * 卡片横穿的缓动，等价于参考站写的 `slow(0.15, 0.6)`：
 * 前 15% 与后 15% 明显减速，中段近似线性——卡片会在正中多停留一会儿。
 */
export const WORK_CARD_EASE = SlowMo.config(0.15, 0.6);

export { gsap, ScrollTrigger, EasePack, SlowMo };
