import { describe, expect, it } from 'vitest'
import { DEFAULT_DANGEROUS_RULES, checkCommand } from '../src/command-guard.ts'

describe('命令守卫', () => {
  describe('默认黑名单拦截', () => {
    const blocked = [
      'rm -rf /',
      'rm -rf /*',
      'rm -fr ~',
      'sudo rm -rf /',
      'rm -rf $HOME',
      'rm -rf / && echo done',
      'mkfs.ext4 /dev/sda1',
      'mkfs /dev/sdb',
      'dd if=/dev/zero of=/dev/sda',
      'reboot',
      'shutdown -h now',
      'halt',
      'poweroff',
      'init 0',
      'RM -RF /', // 大小写不敏感
      ':(){ :|:& };:',
    ]
    for (const cmd of blocked) {
      it(`拦截 "${cmd}"`, () => {
        const decision = checkCommand(cmd)
        expect(decision.verdict, `应拦截: ${cmd}`).toBe('block')
        expect(decision.rule?.why).toBeTruthy()
      })
    }
  })

  describe('正常命令放行', () => {
    const allowed = [
      'show version',
      'ls -la /tmp',
      'rm report.txt',
      'rm -rf /tmp/build', // 删具体目录下的内容，不是根目录本身
      'display interface',
      'ping 10.0.0.1',
      'cat /var/log/syslog',
      'echo hello',
    ]
    for (const cmd of allowed) {
      it(`放行 "${cmd}"`, () => {
        expect(checkCommand(cmd).verdict, `应放行: ${cmd}`).toBe('allow')
      })
    }
  })

  it('白名单优先于黑名单', () => {
    expect(checkCommand('reboot').verdict).toBe('block')
    expect(checkCommand('reboot', { whitelist: ['^reboot$'] }).verdict).toBe('allow')
  })

  it('支持追加自定义规则', () => {
    const extra = [{ pattern: '\\bclear\\s+config\\b', why: '清空设备配置' }]
    expect(checkCommand('clear config').verdict).toBe('allow')
    expect(checkCommand('clear config', { extraRules: extra }).verdict).toBe('block')
  })

  it('默认规则表非空', () => {
    expect(DEFAULT_DANGEROUS_RULES.length).toBeGreaterThan(0)
  })
})
