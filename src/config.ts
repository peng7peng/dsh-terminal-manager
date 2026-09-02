/**
 * 插件配置（Config schema）—— 用户在 cordis.yml 的 `config:` 下覆盖，缺省值写在 schema 里。
 *
 * 约定（DSH docs/user/develop/basic/config）：导出同名的 `Config` 类型 + Schemastery schema，
 * `apply(ctx, config)` 收到的是校验并填好默认值的对象。
 * @module dsh-terminal-manager/config
 */

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** 本地文件面板的默认根目录；空串 = 用 DSH 进程当前目录（apply 时解析，不在模块加载时固定） */
  workspaceRoot: string
  /** Telnet 会话的文件传输（base64 命令模拟，实验性）开关【S5 使用】 */
  telnetFileTransfer: boolean
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().default('').description('本地文件面板默认根目录（留空 = DSH 进程当前目录）'),
  telnetFileTransfer: Schema.boolean().default(true).description('Telnet 会话启用文件传输（实验性，base64 命令模拟）'),
})

/** 把（可能缺省的）配置解析成完整对象：空 workspaceRoot 落到当前目录。 */
export function resolveConfig(input?: Partial<Config>, cwd: () => string = () => process.cwd()): Config {
  const root = input?.workspaceRoot?.trim() ?? ''
  return {
    workspaceRoot: root.length > 0 ? root : cwd(),
    telnetFileTransfer: input?.telnetFileTransfer ?? true,
  }
}
