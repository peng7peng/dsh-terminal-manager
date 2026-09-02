/**
 * F8 浮动窗口的拖动 / 缩放 / 最大化几何 —— 改编自 DSH-better-sidebar（MIT）FreeWindow.tsx：
 * pointer capture + 拖动期间直接写 DOM（每帧一次）+ 松手后提交到 state；去掉了「拖回停靠」。
 * 默认几何：视口居中偏下（D3：每次打开都用默认，不记忆）。
 * @module dsh-terminal-manager/client/editor/useFloatWindow
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

export interface Geometry { x: number; y: number; w: number; h: number }

export const FLOAT_MIN_W = 380
export const FLOAT_MIN_H = 240
/** 窗口顶部不能拖到这条线以上（留出 DSH 顶栏） */
const TOP_LIMIT = 34

export function defaultGeometry(vw: number, vh: number): Geometry {
  const w = Math.max(FLOAT_MIN_W, Math.min(640, vw - 40))
  const h = Math.max(FLOAT_MIN_H, Math.min(420, vh - 120))
  return { x: Math.max(0, Math.round((vw - w) / 2)), y: Math.max(TOP_LIMIT, Math.round(vh * 0.5 - h / 2 + 60)), w, h }
}

export function clampMove(g: Geometry, vw: number, vh: number): Geometry {
  return {
    ...g,
    x: Math.min(Math.max(g.x, 0), Math.max(0, vw - g.w)),
    y: Math.min(Math.max(g.y, TOP_LIMIT), Math.max(TOP_LIMIT, vh - 60)),
  }
}

export function clampResize(g: Geometry, vw: number, vh: number): Geometry {
  return {
    ...g,
    w: Math.round(Math.min(Math.max(g.w, FLOAT_MIN_W), Math.max(FLOAT_MIN_W, vw - g.x))),
    h: Math.round(Math.min(Math.max(g.h, FLOAT_MIN_H), Math.max(FLOAT_MIN_H, vh - g.y))),
  }
}

interface DragState {
  mode: 'move' | 'resize'
  pointerX: number
  pointerY: number
  start: Geometry
  applied: Geometry
}

export interface FloatWindowApi {
  rootRef: React.RefObject<HTMLDivElement>
  style: CSSProperties
  dragging: 'move' | 'resize' | null
  headerHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: () => void
  }
  resizeHandlers: FloatWindowApi['headerHandlers']
}

export function useFloatWindow(maximized: boolean): FloatWindowApi {
  const [geo, setGeo] = useState<Geometry>(() => (typeof window === 'undefined' ? { x: 0, y: 0, w: 640, h: 420 } : defaultGeometry(window.innerWidth, window.innerHeight)))
  const [dragging, setDragging] = useState<'move' | 'resize' | null>(null)
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

  const begin = (mode: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || maximized) return
    if (e.target instanceof Element && e.target.closest('button, input, select, textarea, [data-no-drag]') !== null) return
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
      : clampResize({ ...d.start, w: d.start.w + dx, h: d.start.h + dy }, window.innerWidth, window.innerHeight)
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
    resizeHandlers: { onPointerDown: begin('resize'), onPointerMove: move, onPointerUp: up, onPointerCancel: cancel },
  }
}
