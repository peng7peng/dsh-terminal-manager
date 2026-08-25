# CLAUDE.md — 仓库记忆

本文件保持在一页以内。同一个错误出现两次，就把纠正写进这里。

## 命令

- 构建：`pnpm build`（必须无错误退出）
- 测试：`pnpm test`（全绿；失败的测试永远不许跳过或删除，只能修代码）
- 检查：`pnpm lint`（零警告）
- 集成验证：`pnpm dsh web` 启动宿主，手动验证终端连接/收发（需本地可达的测试设备或回环 mock）

## 验证你的工作

报告任何任务完成前，先跑构建、测试、lint 并粘贴输出。
测试失败时修代码，不要改测试。UI 改动以截图/实际运行画面为准。

## 约定

- TypeScript strict；React 18 + CSS Modules（不用组件库），与 DSH `packages/client` 风格一致。
- 插件是「双半包」：host 半（Cordis 服务/工具）+ 浏览器半（slot 组件），参考 `extensions/ui-cordis`。
- 工具注册遵循 `docs/cookbook/adding-a-tool.md`；终端会话走 `ctx.terminals` backend 契约。

## 架构

一段话心智模型：插件向 `ctx.terminals` 注册 ssh/telnet backend（host 半负责真实连接与 I/O），
通过 `ctx.tools` 向 Agent 暴露连接与收发工具；浏览器半经 WebSocket 传输把会话输出渲染为
xterm.js 终端，配置界面经 `ctx.slots` 挂载进 DSH Web UI。

## Agent 容易犯的错

<每条：错误是什么、怎么修、怎么检查。随开发积累。>

## 钩子（Hooks）

- `hooks/production-gate.sh`：发布门禁，无发布授权时阻止部署动作（exit 2 并说明原因）。
