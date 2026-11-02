/**
 * 文件面板高度约束（纯逻辑，不依赖 React / DSH 组件，便于单测）。
 * @module dsh-terminal-manager/client/files/panel-layout
 */

/** 面板最小高度（像素）。 */
export const PANEL_MIN_H = 120

/** 把拖拽后的高度钳到 [最小高度, 视口 70%]，取整。 */
export function clampPanelHeight(h: number, viewportH: number): number {
  return Math.round(Math.min(Math.max(h, PANEL_MIN_H), Math.max(PANEL_MIN_H, viewportH * 0.7)))
}
