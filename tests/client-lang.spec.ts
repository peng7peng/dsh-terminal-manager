import { describe, expect, it } from 'vitest'
import { extOfPath, languageKeyForExt } from '../client/editor/lang.ts'
import { applyResize, clampMove, clampResize, defaultGeometry, FLOAT_MIN_H, FLOAT_MIN_W } from '../client/editor/useFloatWindow.ts'
import { clampPanelHeight, PANEL_MIN_H } from '../client/files/FilePanel.tsx'

describe('F9 语言映射（纯函数）', () => {
  it('四种支持类型；.txt（TC 脚本）与其余不着色', () => {
    expect(languageKeyForExt('sh')).toBe('shell')
    expect(languageKeyForExt('bash')).toBe('shell')
    expect(languageKeyForExt('py')).toBe('python')
    expect(languageKeyForExt('json')).toBe('json')
    expect(languageKeyForExt('md')).toBe('markdown')
    expect(languageKeyForExt('txt')).toBeNull()
    expect(languageKeyForExt('csv')).toBeNull()
    expect(languageKeyForExt('ini')).toBeNull()
    expect(languageKeyForExt('')).toBeNull()
  })
  it('extOfPath：Windows / POSIX / 无扩展名 / 点文件', () => {
    expect(extOfPath('D:\\ws\\a\\case1.TXT')).toBe('txt')
    expect(extOfPath('/x/run.py')).toBe('py')
    expect(extOfPath('/x/README')).toBe('')
    expect(extOfPath('/x/.bashrc')).toBe('')
  })
})

describe('F8 浮动窗几何（纯函数）', () => {
  it('默认几何：居中偏下，不超过视口，不小于最小尺寸', () => {
    const g = defaultGeometry(1600, 900)
    expect(g.w).toBe(640)
    expect(g.h).toBe(420)
    expect(g.x).toBe(480)
    expect(g.y).toBe(300)
    const small = defaultGeometry(400, 300)
    expect(small.w).toBe(FLOAT_MIN_W)
    expect(small.h).toBe(FLOAT_MIN_H)
    expect(small.x).toBe(10)
    expect(small.y).toBe(90)
  })
  it('applyResize：四角四边——拖左/上边时对边不动；小于最小尺寸时把 x/y 顶回；不出视口', () => {
    const g = { x: 200, y: 200, w: 500, h: 400 }
    expect(applyResize(g, 'se', 50, 30, 2000, 1500)).toEqual({ x: 200, y: 200, w: 550, h: 430 })
    expect(applyResize(g, 'nw', -50, -30, 2000, 1500)).toEqual({ x: 150, y: 170, w: 550, h: 430 })
    expect(applyResize(g, 'ne', 50, -30, 2000, 1500)).toEqual({ x: 200, y: 170, w: 550, h: 430 })
    expect(applyResize(g, 'sw', -50, 30, 2000, 1500)).toEqual({ x: 150, y: 200, w: 550, h: 430 })
    expect(applyResize(g, 'e', 50, 999, 2000, 1500)).toEqual({ x: 200, y: 200, w: 550, h: 400 })
    expect(applyResize(g, 'n', 999, -30, 2000, 1500)).toEqual({ x: 200, y: 170, w: 500, h: 430 })
    // 左边往右拖过头：宽度钉在最小值，右边不动 → x = right - minW
    expect(applyResize(g, 'w', 400, 0, 2000, 1500)).toEqual({ x: 700 - FLOAT_MIN_W, y: 200, w: FLOAT_MIN_W, h: 400 })
    // 上边往下拖过头：高度钉在最小值，下边不动
    expect(applyResize(g, 'n', 0, 300, 2000, 1500)).toEqual({ x: 200, y: 600 - FLOAT_MIN_H, w: 500, h: FLOAT_MIN_H })
    // 拖出视口：左边不能越过 0，上边不能越过顶栏线 34，右 / 下不能越过视口
    expect(applyResize(g, 'nw', -500, -500, 2000, 1500)).toEqual({ x: 0, y: 34, w: 700, h: 566 })
    expect(applyResize(g, 'se', 5000, 5000, 1000, 800)).toEqual({ x: 200, y: 200, w: 800, h: 600 })
  })

  it('clampPanelHeight：最小 120，最大视口 70%', () => {
    expect(clampPanelHeight(50, 1000)).toBe(PANEL_MIN_H)
    expect(clampPanelHeight(300, 1000)).toBe(300)
    expect(clampPanelHeight(900, 1000)).toBe(700)
  })

  it('clampMove：不出左上，右下留边；clampResize：最小尺寸与视口余量', () => {
    expect(clampMove({ x: -50, y: 0, w: 400, h: 300 }, 1000, 800)).toMatchObject({ x: 0, y: 34 })
    expect(clampMove({ x: 900, y: 790, w: 400, h: 300 }, 1000, 800)).toMatchObject({ x: 600, y: 740 })
    expect(clampResize({ x: 100, y: 100, w: 10, h: 10 }, 1000, 800)).toMatchObject({ w: FLOAT_MIN_W, h: FLOAT_MIN_H })
    expect(clampResize({ x: 100, y: 100, w: 5000, h: 5000 }, 1000, 800)).toMatchObject({ w: 900, h: 700 })
  })
})
