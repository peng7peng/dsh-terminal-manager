import { describe, expect, it } from 'vitest'
import { extOfPath, languageKeyForExt } from '../client/editor/lang.ts'
import { clampMove, clampResize, defaultGeometry, FLOAT_MIN_H, FLOAT_MIN_W } from '../client/editor/useFloatWindow.ts'

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
  it('clampMove：不出左上，右下留边；clampResize：最小尺寸与视口余量', () => {
    expect(clampMove({ x: -50, y: 0, w: 400, h: 300 }, 1000, 800)).toMatchObject({ x: 0, y: 34 })
    expect(clampMove({ x: 900, y: 790, w: 400, h: 300 }, 1000, 800)).toMatchObject({ x: 600, y: 740 })
    expect(clampResize({ x: 100, y: 100, w: 10, h: 10 }, 1000, 800)).toMatchObject({ w: FLOAT_MIN_W, h: FLOAT_MIN_H })
    expect(clampResize({ x: 100, y: 100, w: 5000, h: 5000 }, 1000, 800)).toMatchObject({ w: 900, h: 700 })
  })
})
