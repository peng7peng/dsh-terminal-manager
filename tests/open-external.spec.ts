import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// vi.mock 被提升到文件顶部执行；mockedSpawn 在工厂里创建，
// 各测试通过 mockedSpawn.mockReturnValue(child) 注入不同的 child 对象
const mockChild = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
mockChild.unref = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockChild),
}))

const { defaultSpawn, openCommandFor, openWithSystem } = await import('../src/open-external.ts')
const { openTargetFor, isTextEditable } = await import('../client/files/openRule.ts')

describe('系统默认程序打开', () => {
  it('Windows 日志直接用记事本打开，中文、空格和括号路径作为完整参数传递', async () => {
    const path = 'C:\\日志 & 文件\\vm test(2026-09-08_23-00-00).LOG'
    const spawnFn = vi.fn(async () => {})
    await openWithSystem(path, spawnFn, 'win32')
    expect(spawnFn).toHaveBeenCalledWith('notepad.exe', [path])
  })
  it('按平台选命令：Windows 用 cmd /c start "" <path>（带空格路径不被当标题）', () => {
    expect(openCommandFor('win32', 'D:\\a b\\x.xlsx')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'D:\\a b\\x.xlsx'] })
    expect(openCommandFor('darwin', '/x/y.pdf')).toEqual({ cmd: 'open', args: ['/x/y.pdf'] })
    expect(openCommandFor('linux', '/x/y.pdf')).toEqual({ cmd: 'xdg-open', args: ['/x/y.pdf'] })
  })
  it('openWithSystem 把命令交给注入的 spawn', async () => {
    const spawnFn = vi.fn(async () => {})
    await openWithSystem('/tmp/a.xlsx', spawnFn, 'linux')
    expect(spawnFn).toHaveBeenCalledWith('xdg-open', ['/tmp/a.xlsx'])
  })
})

describe('defaultSpawn（缺省 spawn 实现）', () => {
  it('spawn 事件触发 → resolve + unref', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const { spawn: mockedSpawn } = await import('node:child_process')
    ;(mockedSpawn as ReturnType<typeof vi.fn>).mockReturnValue(child)

    const p = defaultSpawn('xdg-open', ['/x.pdf'])
    child.emit('spawn')
    await expect(p).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalled()
  })

  it('error 事件触发 → reject', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const { spawn: mockedSpawn } = await import('node:child_process')
    ;(mockedSpawn as ReturnType<typeof vi.fn>).mockReturnValue(child)

    const p = defaultSpawn('badcmd', [])
    child.emit('error', new Error('spawn badcmd ENOENT'))
    await expect(p).rejects.toThrow('spawn badcmd ENOENT')
  })
})

describe('openCommandFor 平台分支', () => {
  it('Windows .log → notepad.exe；Windows 其他 → cmd /c start', () => {
    expect(openCommandFor('win32', 'C:\\test.log')).toEqual({ cmd: 'notepad.exe', args: ['C:\\test.log'] })
    expect(openCommandFor('win32', 'D:\\report.pdf')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'D:\\report.pdf'] })
  })
  it('darwin → open；其他 → xdg-open', () => {
    expect(openCommandFor('darwin', '/x/y.pdf')).toEqual({ cmd: 'open', args: ['/x/y.pdf'] })
    expect(openCommandFor('linux', '/x/y.pdf')).toEqual({ cmd: 'xdg-open', args: ['/x/y.pdf'] })
    expect(openCommandFor('freebsd', '/x/y.pdf')).toEqual({ cmd: 'xdg-open', args: ['/x/y.pdf'] })
  })
})


describe('双击分流规则（前端纯函数）', () => {
  it('文本类进编辑器，Office / PDF / 图片 / 压缩包走系统程序，无扩展名当文本', () => {
    for (const n of ['case1.txt', 'a.md', 'run.py', 'x.sh', 'c.json', 's.ini', 'd.csv', 'n.log', 'y.yaml', 'README', 'Makefile']) {
      expect(openTargetFor(n)).toBe('editor')
    }
    for (const n of ['t.xlsx', 't.xls', 'd.docx', 'p.pdf', 'i.png', 'z.zip', 'b.bin', 'e.exe']) {
      expect(openTargetFor(n)).toBe('system')
    }
    expect(isTextEditable('.gitignore')).toBe(true)
    expect(isTextEditable('X.TXT')).toBe(true)
  })
})
