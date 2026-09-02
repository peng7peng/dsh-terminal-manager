/**
 * B11 TC 脚本解析：用脱敏后的真实样例结构（地址 / 账号已替换）整段跑。
 */
import { describe, expect, it } from 'vitest'
import { commandLines, delayHints, parseTargetDigits, parseTcScript, resolveTargetsAt, sectionRange } from '../src/tc-parser.ts'

const SAMPLE = [
  '[hdd启动]',                                   // 1
  '##>0',                                        // 2
  'provision 10.0.0.1 -u user -p pass -f ./img -a 0x20000000', // 3
  '##>1',                                        // 4
  'ifconfig -s eth0 static 10.0.1.79 255.255.254.0 10.0.1.1', // 5
  '##>12',                                       // 6
  'insmod /modules/drv.ko',                      // 7
  '',                                            // 8
  '[调试网口驱动]',                               // 9
  '##>0',                                        // 10
  'ifconfig eth0 10.0.1.77 netmask 255.255.254.0 ', // 11（行尾空格）
  '##>012',                                      // 12
  'insmod ub_ktc.ko',                            // 13
  '[路由配置]',                                   // 14（标题不重置目标）
  'echo "call \\"set_route_stream\\",14" | unibsp.out shell', // 15
  '#小标题',                                      // 16
  '##注释行',                                     // 17
  '###echo sendable-comment',                    // 18
  '##>01',                                       // 19（空目标块）
  '',                                            // 20
  '##间隔5s再发',                                 // 21
  '',                                            // 22
  '##>0',                                        // 23
  'call() {',                                    // 24
  '  local s="$1"',                              // 25
  '}',                                           // 26
  '[!隐藏小标题的节]',                             // 27
  'stc case.xml&',                               // 28
].join('\n') + '\n'

describe('parseTargetDigits', () => {
  it('拆单个数字、去重、保序', () => {
    expect(parseTargetDigits('012')).toEqual([0, 1, 2])
    expect(parseTargetDigits('2102')).toEqual([2, 1, 0])
    expect(parseTargetDigits('9')).toEqual([9])
  })
})

describe('parseTcScript（整段样例）', () => {
  const lines = parseTcScript(SAMPLE)

  it('行数与行号：末尾换行不多出一行', () => {
    expect(lines).toHaveLength(28)
    expect(lines[0]?.lineNo).toBe(1)
    expect(lines[27]?.lineNo).toBe(28)
  })

  it('##> 切换目标，命令跟随当前目标；多目标拆成数组', () => {
    expect(lines[1]).toMatchObject({ kind: 'target', targets: [0] })
    expect(lines[2]).toMatchObject({ kind: 'command', targets: [0] })
    expect(lines[4]).toMatchObject({ kind: 'command', targets: [1] })
    expect(lines[5]).toMatchObject({ kind: 'target', targets: [1, 2] })
    expect(lines[6]).toMatchObject({ kind: 'command', targets: [1, 2], command: 'insmod /modules/drv.ko' })
  })

  it('文件开头未切换时默认目标 [0]', () => {
    expect(lines[0]).toMatchObject({ kind: 'section', section: 'hdd启动', targets: [0] })
    expect(parseTcScript('ls\n')[0]).toMatchObject({ kind: 'command', targets: [0] })
  })

  it('[标题] 不发送且不重置目标；[!标题] 也是标题', () => {
    expect(lines[13]).toMatchObject({ kind: 'section', section: '路由配置', targets: [0, 1, 2] })
    expect(lines[14]).toMatchObject({ kind: 'command', targets: [0, 1, 2] })
    expect(lines[26]).toMatchObject({ kind: 'section', section: '隐藏小标题的节', targets: [0] })
  })

  it('# 小标题 / ## 注释不发送；### 整行发送', () => {
    expect(lines[15]?.kind).toBe('subtitle')
    expect(lines[16]?.kind).toBe('comment')
    expect(lines[17]).toMatchObject({ kind: 'command', command: '###echo sendable-comment' })
  })

  it('命令右侧去空白、左侧保留（函数体缩进）', () => {
    expect(lines[10]?.command).toBe('ifconfig eth0 10.0.1.77 netmask 255.255.254.0')
    expect(lines[24]?.command).toBe('  local s="$1"')
  })

  it('##>01 后只有空行 = 纯切换，不报错', () => {
    expect(lines[18]).toMatchObject({ kind: 'target', targets: [0, 1] })
    expect(lines[19]?.kind).toBe('blank')
    expect(lines[20]).toMatchObject({ kind: 'comment', targets: [0, 1] })
  })

  it('##> 后不是数字 → 当普通注释', () => {
    const l = parseTcScript('##>abc\nls\n')
    expect(l[0]?.kind).toBe('comment')
    expect(l[1]).toMatchObject({ kind: 'command', targets: [0] })
  })

  it('CRLF 换行也能解析', () => {
    const l = parseTcScript('##>2\r\nls\r\n')
    expect(l[1]).toMatchObject({ kind: 'command', command: 'ls', targets: [2] })
  })

  it('commandLines 只留命令行', () => {
    const cmds = commandLines(lines)
    expect(cmds.map(c => c.lineNo)).toEqual([3, 5, 7, 11, 13, 15, 18, 24, 25, 26, 28])
  })

  it('delayHints 找出「间隔 N 秒」提示', () => {
    expect(delayHints(lines)).toEqual([{ lineNo: 21, text: '间隔5s再发' }])
  })
})

describe('选区执行辅助', () => {
  const lines = parseTcScript(SAMPLE)

  it('resolveTargetsAt：取该行之前最后一次 ##>；开头缺省 [0]', () => {
    expect(resolveTargetsAt(lines, 1)).toEqual([0])
    expect(resolveTargetsAt(lines, 2)).toEqual([0])
    expect(resolveTargetsAt(lines, 3)).toEqual([0])
    expect(resolveTargetsAt(lines, 7)).toEqual([1, 2])
    expect(resolveTargetsAt(lines, 15)).toEqual([0, 1, 2])
    expect(resolveTargetsAt(lines, 12)).toEqual([0])   // 第 12 行本身是 ##>012，不含该行
  })

  it('选区解析：initialTargets + lineOffset 让行号与目标和整文一致', () => {
    const start = 24
    const selected = SAMPLE.split('\n').slice(start - 1, 26).join('\n')
    const sub = parseTcScript(selected, { initialTargets: resolveTargetsAt(lines, start), lineOffset: start - 1 })
    expect(sub.map(l => l.lineNo)).toEqual([24, 25, 26])
    expect(sub.every(l => l.targets.length === 1 && l.targets[0] === 0)).toBe(true)
    // 选区里自带 ##> 时以选区内为准
    const sub2 = parseTcScript('##>3\nls\n', { initialTargets: [7], lineOffset: 0 })
    expect(sub2[1]?.targets).toEqual([3])
  })

  it('sectionRange：从标题到下一个标题之前；位置在首个标题前则从首行起', () => {
    expect(sectionRange(lines, 5)).toEqual({ start: 1, end: 8, section: 'hdd启动' })
    expect(sectionRange(lines, 9)).toEqual({ start: 9, end: 13, section: '调试网口驱动' })
    expect(sectionRange(lines, 20)).toEqual({ start: 14, end: 26, section: '路由配置' })
    expect(sectionRange(lines, 28)).toEqual({ start: 27, end: 28, section: '隐藏小标题的节' })
    const noHead = parseTcScript('ls\npwd\n[a]\nx\n')
    expect(sectionRange(noHead, 1)).toEqual({ start: 1, end: 2 })
    expect(sectionRange([], 1)).toBeUndefined()
  })
})
