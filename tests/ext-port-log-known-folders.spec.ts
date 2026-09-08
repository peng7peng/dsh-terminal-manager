import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveKnownFolders, type KnownFolders } from '../src/ext/port-log/known-folders.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async (home) => {
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true })
  }))
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tm-known-'))
  homes.push(home)
  return home
}

describe('resolveKnownFolders', () => {
  it('快速访问：只收录实际存在的目录，桌面与文档支持 OneDrive 回退', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'Desktop'))
    await mkdir(join(home, 'Downloads'))
    const known = await resolveKnownFolders({ platform: 'win32', home })
    const labels = known.quick.map(q => q.label)
    expect(labels).toContain('桌面')
    expect(labels).toContain('下载')
    expect(labels).not.toContain('文档') // 未创建
    expect(known.quick.find(q => q.label === '桌面')?.path).toBe(join(home, 'Desktop'))
  })

  it('OneDrive 重定向时使用 OneDrive 子目录；两者都不存在则整个入口被跳过', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'OneDrive', 'Desktop'), { recursive: true })
    const known = await resolveKnownFolders({ platform: 'win32', home })
    expect(known.quick.find(q => q.label === '桌面')?.path).toBe(join(home, 'OneDrive', 'Desktop'))
    expect(known.quick.find(q => q.label === '下载')).toBeUndefined()
  })

  it('Windows：此电脑返回所有可用盘符', async () => {
    const known = await resolveKnownFolders({ platform: 'win32', home: await makeHome() })
    expect(known.drives.length).toBeGreaterThan(0)
    expect(known.drives.every(d => /^[A-Z]:$/.test(d.label))).toBe(true)
  })

  it('POSIX：此电脑只给根目录 /', async () => {
    const known: KnownFolders = await resolveKnownFolders({ platform: 'linux', home: await makeHome() })
    expect(known.drives).toEqual([{ label: '/', path: '/' }])
  })
})
