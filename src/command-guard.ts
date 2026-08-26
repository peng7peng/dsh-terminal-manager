/**
 * B8 命令守卫 —— AI 发送前的安检门（见方案 3.7）。
 *
 * 只检查 AI 发起的命令（tm_send / tm_send_all）；人的键盘输入不经过这里。
 * 黑名单命中即拦截；白名单（按连接配置）优先豁免。纯逻辑，规则可配置。
 * @module dsh-terminal-manager/command-guard
 */

export interface GuardRule {
  /** 正则源（大小写不敏感匹配） */
  pattern: string
  /** 拦截时给 AI/用户看的原因 */
  why: string
}

export type GuardVerdict = 'allow' | 'block'

export interface GuardDecision {
  verdict: GuardVerdict
  /** 命中拦截时的规则 */
  rule?: GuardRule
}

export interface GuardOptions {
  /** 在默认黑名单之外追加的规则 */
  extraRules?: readonly GuardRule[]
  /** 白名单正则源列表；命中任意一条即放行（优先于黑名单） */
  whitelist?: readonly string[]
}

/** 默认黑名单：典型破坏性命令（可按部署扩充）。 */
export const DEFAULT_DANGEROUS_RULES: readonly GuardRule[] = [
  { pattern: '\\brm\\s+(-[a-z]+\\s+)*(/|/\\*|~|\\$HOME)\\s*(?:[;&|]|$)', why: '递归删除根目录/主目录' },
  { pattern: '\\bmkfs(\\.[a-z0-9]+)?\\b', why: '格式化文件系统' },
  { pattern: '\\bdd\\b[^|;&]*\\bof=/dev/', why: '对磁盘设备低层写入' },
  { pattern: '\\b(shutdown|reboot|halt|poweroff)\\b', why: '关机/重启设备' },
  { pattern: '\\binit\\s+0\\b', why: '关机' },
  { pattern: ':\\(\\)\\s*\\{', why: 'fork 炸弹' },
]

/** 检查一条命令。白名单优先；黑名单命中返回 block + 原因。 */
export function checkCommand(command: string, options: GuardOptions = {}): GuardDecision {
  if (options.whitelist !== undefined) {
    for (const source of options.whitelist) {
      if (new RegExp(source, 'i').test(command)) return { verdict: 'allow' }
    }
  }
  const rules = [...DEFAULT_DANGEROUS_RULES, ...(options.extraRules ?? [])]
  for (const rule of rules) {
    if (new RegExp(rule.pattern, 'i').test(command)) {
      return { verdict: 'block', rule }
    }
  }
  return { verdict: 'allow' }
}
