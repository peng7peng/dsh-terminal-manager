/**
 * F8 浮动窗口的拖动 / 缩放 / 最大化几何 —— 改编自 DSH-better-sidebar（MIT）FreeWindow.tsx：
 * pointer capture + 拖动期间直接写 DOM（每帧一次）+ 松手后提交到 state；去掉了「拖回停靠」。
 * 缩放支持四角 + 四边（行为同浏览器窗口）；默认几何：视口居中偏下（D3：每次打开都用默认，不记忆）。
 * @module dsh-terminal-manager/client/editor/useFloatWindow
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

export interface Geometry { x: number; y: number; w: number; h: number }

export const FLOAT_MIN_W = 380
export const FLOAT_MIN_H = 240
/** 窗口顶部不能拖到这条线以上（留出 DSH 顶栏） */
const TOP_LIMIT = 34

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const RESIZE_DIRS: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export function defaultGeometry(vw: number, vh: number): Geometry {
  const w = Math.max(FLOAT_MIN_W, Math.min(640, vw - 40))
  const h = Math.max(FLOAT_MIN_H, Math.min(420, vh - 120))
  return { x: Math.max(0, Math.round((vw - w) / 2)), y: Math.max(TOP_LIMIT, Math.round(vh * 0.5 - h / 2 + 60)), w, h }
}

export function clampMove(g: Geometry, vw: number, vh: number): Geometry {
  return {
    ...g,
    x: Math.min(Math.max(g.x, 0), Math.max(0, vw - g.w)),
    // 下边钳到「整个窗口可见」（与横向一致）；之前钳在 vh-60，窗口会悬出视口只剩一条标题栏，看起来像高度被压小
    y: Math.min(Math.max(g.y, TOP_LIMIT), Math.max(TOP_LIMIT, vh - g.h)),
  }
}

/** 右下角缩放（保留给旧调用方 / 测试）。 */
export function clampResize(g: Geometry, vw: number, vh: number): Geometry {
  return applyResize(g, 'se', g.w - g.w, g.h - g.h, vw, vh, g)
}

/**
 * 按方向缩放：从 start 出发，鼠标位移 (dx, dy)。
 * 含 w 的方向动左边（x 变、w 反向变），含 n 的方向动上边；最小尺寸与视口边界都钳住，
 * 被钳住的一侧保持对边不动（与浏览器窗口一致）。
 */
export function applyResize(start: Geometry, dir: ResizeDir, dx: number, dy: number, vw: number, vh: number, _unused?: Geometry): Geometry {
  let { x, y, w, h } = start
  const right = start.x + start.w
  const bottom = start.y + start.h
  if (dir.includes('e')) w = start.w + dx
  if (dir.includes('s')) h = start.h + dy
  if (dir.includes('w')) { x = start.x + dx; w = right - x }
  if (dir.includes('n')) { y = start.y + dy; h = bottom - y }
  // 最小尺寸：左 / 上边被拖过头时把 x / y 顶回去，右 / 下边不动
  if (w < FLOAT_MIN_W) { if (dir.includes('w')) x = right - FLOAT_MIN_W; w = FLOAT_MIN_W }
  if (h < FLOAT_MIN_H) { if (dir.includes('n')) y = bottom - FLOAT_MIN_H; h = FLOAT_MIN_H }
  // 视口边界
  if (x < 0) { w += x; x = 0 }
  if (y < TOP_LIMIT) { h -= TOP_LIMIT - y; y = TOP_LIMIT }
  if (x + w > vw) w = Math.max(FLOAT_MIN_W, vw - x)
  if (y + h > vh) h = Math.max(FLOAT_MIN_H, vh - y)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(FLOAT_MIN_W, w)), h: Math.round(Math.max(FLOAT_MIN_H, h)) }
}

interface DragState {
  mode: 'move' | ResizeDir
  pointerX: number
  pointerY: number
  start: Geometry
  applied: Geometry
}

export interface PointerHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: () => void
}

export interface FloatWindowApi {
  rootRef: React.RefObject<HTMLDivElement>
  style: CSSProperties
  dragging: 'move' | ResizeDir | null
  headerHandlers: PointerHandlers
  resizeHandlers: (dir: ResizeDir) => PointerHandlers
}

/** 标题条里这些元素上按下不算拖动（点它们有自己的语义）。 */
const NO_DRAG_SELECTOR = 'button, input, select, textarea, a, .tm-feTab, [data-no-drag]'

export function useFloatWindow(maximized: boolean): FloatWindowApi {
  const [geo, setGeo] = useState<Geometry>(() => (typeof window === 'undefined' ? { x: 0, y: 0, w: 640, h: 420 } : defaultGeometry(window.innerWidth, window.innerHeight)))
  const [dragging, setDragging] = useState<'move' | ResizeDir | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<Geometry | null>(null)

  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current) }, [])

  const writeDom = (g: Geometry): void => {
    const root = rootRef.current
    if (root === null) return
    root.style.left = `${g.x}px`
    root.style.top = `${g.y}px`
    root.style.width = `${g.w}px`
    root.style.height = `${g.h}px`
  }
  const scheduleApply = (g: Geometry): void => {
    pendingRef.current = g
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const p = pendingRef.current
      const d = dragRef.current
      if (p === null || d === null) return
      d.applied = p
      writeDom(p)
    })
  }
  const finish = (): void => {
    const d = dragRef.current
    if (d === null) return
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
    const final = pendingRef.current ?? d.applied
    pendingRef.current = null
    dragRef.current = null
    writeDom(final)
    setGeo(final)
    setDragging(null)
  }

  const begin = (mode: 'move' | ResizeDir) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || maximized) return
    if (mode === 'move' && e.target instanceof Element && e.target.closest(NO_DRAG_SELECTOR) !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { mode, pointerX: e.clientX, pointerY: e.clientY, start: geo, applied: geo }
    setDragging(mode)
  }
  const move = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = dragRef.current
    if (d === null) return
    const dx = e.clientX - d.pointerX
    const dy = e.clientY - d.pointerY
    const next = d.mode === 'move'
      ? clampMove({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }, window.innerWidth, window.innerHeight)
      : applyResize(d.start, d.mode, dx, dy, window.innerWidth, window.innerHeight)
    scheduleApply(next)
  }
  const up = (e: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current === null) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    move(e)
    finish()
  }
  const cancel = useCallback((): void => { finish() }, [])

  const style: CSSProperties = maximized
    ? { left: 8, top: TOP_LIMIT, right: 8, bottom: 8, width: 'auto', height: 'auto' }
    : { left: geo.x, top: geo.y, width: geo.w, height: geo.h }

  return {
    rootRef,
    style,
    dragging,
    headerHandlers: { onPointerDown: begin('move'), onPointerMove: move, onPointerUp: up, onPointerCancel: cancel },
    resizeHandlers: (dir) => ({ onPointerDown: begin(dir), onPointerMove: move, onPointerUp: up, onPointerCancel: cancel }),
  }
}
