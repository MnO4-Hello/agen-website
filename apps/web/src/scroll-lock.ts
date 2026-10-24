/**
 * 滚动锁期间“页面其实滚到哪了”。
 *
 * 开场播放要钉住页面时，`../sections/identity.ts` 会把 `body` 改成 `position:
 * fixed`（配合写进 `top` 的负偏移，画面才不会跳）。这个改法有个副作用：浏览器会
 * 把 `window.scrollY` 归零——毕竟页面已经不滚了。于是所有直接读 `window.scrollY`
 * 的效果（首屏视差、导航栏折叠）都会以为“回到了页面顶部”，把已经收成胶囊的导航
 * 栏又铺开，沉浸感全没了。
 *
 * 这里记住被锁住时真实的滚动位置，让这些效果读 `effectiveScrollY()`：锁定期间它
 * 等于被冻住的那个位置，平时就是 `window.scrollY`，两边语义一致。
 */

let lockedOffset = 0;

/** 进入锁定前调用：记住当前真实的滚动位置。 */
export function markScrollLocked(offset: number): void {
  lockedOffset = offset;
}

/** 退出锁定后调用。 */
export function clearScrollLock(): void {
  lockedOffset = 0;
}

/** 真实滚动量：锁定期间是被冻住的位置，平时就是 `window.scrollY`。 */
export function effectiveScrollY(): number {
  return window.scrollY + lockedOffset;
}
