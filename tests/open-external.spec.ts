import { describe, expect, it, vi } from 'vitest'
import { openCommandFor, openWithSystem } from '../src/open-external.ts'
import { openTargetFor, isTextEditable } from '../client/files/openRule.ts'

describe('系统默认程序打开', () => {
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
