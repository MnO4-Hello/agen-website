/**
 * 视图的公共契约。
 *
 * `AdminView` 必须提供 `dispose()`：控制台持有一条 SSE 连接，文件预览持有可能未保存的
 * 编辑状态——切走时都要收干净。`renderShell()` 负责在切换前调用它。
 */

export interface AdminView {
  element: HTMLElement;
  dispose: () => void;
}
