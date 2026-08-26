# CLAUDE.md — 仓库记忆

本文件保持在一页以内。同一个错误出现两次，就把纠正写进这里。
**新接手的 AI：先读 `HANDOVER.zh.md`（进度/待办/共识/坑全在那）。**

## 命令

- 构建：`pnpm build`（tsdown 产出 `lib/index.js` host 半 + `lib/client.js` 浏览器半工厂包）
- 测试：`pnpm test`（vitest；**64 项全绿是基线**，改挂必须修绿再提交）
- 启动验证：在 `../deepseek-harness` 下 `pnpm dsh --profile tm-dev --port 3180 --no-open`
  - 健康判据：`/plugins/dsh-terminal-manager/client.js` 返回 200；首页 `__DSH_BOOT__` 含 `dsh-terminal-manager` 行
  - **3080 被用户自己的 DSH 占用，别动**；验证一律 3180

## 验证你的工作

报告任务完成前跑 `pnpm build` + `pnpm test` 并粘贴输出。
测试失败修代码，不改测试。测试用 `tests/helpers.ts` 的模拟设备，不碰用户真实设备。

## 约定

- TypeScript strict；React 18 + CSS Modules（无组件库），与 DSH `packages/client` 一致。
- 插件是「双半包」：host 半（Cordis 模块）+ 浏览器半（slot 组件），参考 `extensions/ui-cordis`。
- **会话不用 `ctx.terminals`**（那是 AI 私有本机 PTY）；本插件自持 `SessionManager` 公共会话池——人机共用是核心需求。
- 工具注册遵循 `../deepseek-harness/docs/cookbook/adding-a-tool.md`。
- AI 路径的发送必过命令守卫（`guard` 参数）；人的键入不过。错误格式 `{code, message}`，message 永不带凭据。
- 所有文档、提交信息用中文；跟用户说人话（用户懂 C++/Python，不懂 TS）。

## 架构

host 半：三个门（AI 工具 B6 / 指令通道 B7a / 数据流通道 B7b）汇入 **B4 会话管理器**（状态机 + 1MB 环形缓冲 + 输出分发 + 独占发送 + 广播），B4 唯一接触 **B2 SSH / B3 Telnet** 传输；**B5 完成判定**（静默 500ms / 提示符正则 / 超时 30s，优先级 提示符 > 静默 > 超时）；**B1 连接存储**管配置落盘；**B8 命令守卫**拦 AI 危险命令。浏览器半经 通道① HTTP / 通道② WebSocket 与后端通信。详见 `docs/solution.zh.md`。

## Agent 容易犯的错

1. **node 在 Windows 不吃 `/d/...` 路径**——脚本里用 `D:/...`；`/tmp` 对 node 不存在。
2. **pnpm 构建豁免写在 `pnpm-workspace.yaml` 的 `allowBuilds:`**（cpu-features/ssh2=false 走纯 JS），写进 package.json 的 pnpm 字段不生效。
3. **写 ssh2 测试服务器必须处理 `session.on('pty', accept)`**，否则客户端 `shell()` 报 "Unable to request a pseudo-terminal"。
4. **DSH 没有 `ctx.router`/`ctx.ws`**——路由用 `ctx.webServer.register/registerUpgrade`（参考 `packages/client/connection/src/index.ts`）。
5. **多会话测试里每个 connect 要独立回调槽位**——共用一个回调变量会被后连的会话覆盖，导致先连的会话收不到数据（测试挂 20 秒超时）。

## 钩子（Hooks）

- `hooks/production-gate.sh`：发布门禁，无发布授权时阻止部署动作（exit 2 并说明原因）。
