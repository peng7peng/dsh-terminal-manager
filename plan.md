# DSH Terminal Manager — 构建计划

- 派生自：`spec.md`（唯一设计源，已合并原 `docs/solution.zh.md`）
- 状态：M0–M5 已全部完成（2026-08-26）；本文件按 SDLC 规则 6 随实现偏离同步更新
- 日期：2026-08-25
- 修订：
  - 2026-08-25 插入「方案讲解 + GUI 方案选型」里程碑（M1）
  - 2026-08-28 同步真实实现的偏离（见下「实现偏离记录」）；`docs/connections-panel-upgrade.zh.md` 的剩余待办并入本文「后续待办」段，原文件已归档

## 实现偏离记录（规则 6：偏离即同提交更新）

实施中相对原计划的偏离，均在 `spec.md` 体现为真实设计：
1. **控制面**：原计划走 `ctx.typert.remotes` 的 `/api` RPC；实际改为 `ctx.webServer.register` 独立前缀路由 `/term-manager`（绕开 connection.rpc 作用域问题 + `/api` 与 api-gateway 冲突），含 OPTIONS 预检。
2. **GUI**：原计划挂「右侧 details 栏 + 终端/连接双页签」；实际改为 `shell.overlay` 全屏覆盖层工作区，终端模块 + 连接面板左右并排（非页签）。
3. **终端宽度**：原计划未定；实际做了响应式——终端模块目标宽 480、未拖动时聊天填满左侧无留白、拖动上限随视口动态 `max(760, 视口宽-764)`、终端网格 `auto-fit + 1fr` 填满。
4. **Telnet**：原计划裸 TCP 透传；实际加 `telnetMode: 'telnet'|'raw'`，telnet 模式剥离 IAC（Buffer 操作、只剥离不回发）。
5. **连接配置**：新增 `telnetMode`/`handshakeTimeoutSec`/`newline`/`localEcho`/`guardWhitelist`/`timeoutMs` 字段；sendAndWait 用配置的换行。
6. **文件名**：原计划的 `TerminalPanel.tsx`/`ConnectionsTab.tsx`/`TerminalsTab.tsx`/`*.module.css`/`config.ts` 均未采用；实际见下「改动文件（真实）」。

## 改动文件（真实，M0–M5 已落地）

### host 半（`src/`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 入口：装配 ConnectionStore、SessionManager、`tm_*` 工具、`/term-manager` 路由、`/term-io` WS；`ctx.effect` 清理 |
| `src/connection-store.ts` | 连接配置 CRUD + JSON 持久化（0600）+ 校验；含 telnetMode/handshakeTimeoutSec/newline/localEcho 等字段 |
| `src/wait-policy.ts` | 完成判定三重机制（静默期/提示符正则/超时）纯函数状态机 |
| `src/command-guard.ts` | 命令守卫（AI 路径黑名单 + 白名单） |
| `src/transport/types.ts` | 传输层内部接口 |
| `src/transport/ssh.ts` | ssh2 shell 通道；密码/密钥认证；可配握手超时；主机密钥指纹采集（MVP 接受任意） |
| `src/transport/telnet.ts` | `net.connect`；telnet 模式剥离 IAC，raw 透传 |
| `src/session-manager.ts` | 会话状态机、环形缓冲（1MiB）、订阅、独占发送、广播；用配置的换行 |
| `src/tools.ts` | 六个 `tm_*`（defineTool）+ `ctx.systemPrompt.section` |
| `src/remotes.ts` | `/term-manager` HTTP 路由（`createHttpHandler`）；`connections.*` 与 `sessions.*` 控制面 |
| `src/ws-io.ts` | `/term-io` WebSocket upgrade + 帧协议 + 信任栅栏（loopback） |

### 浏览器半（`client/`）

| 文件 | 职责 |
|---|---|
| `client/index.tsx` | `apply(ClientContext)`：locale、`sidebar.footer.action` 入口、插槽挂载、样式注入 |
| `client/TerminalWorkspace.tsx` | 覆盖层外壳 + 布局（`useFrameLayout`）+ 终端网格 + 广播栏（两行） |
| `client/ConnectionsPanel.tsx` | 连接面板：表单 + 收藏 + 最近 + 活跃会话 + 右键菜单 + 拖动排序 |
| `client/TermView.tsx` | xterm.js 封装：WS attach/输入/回放/尺寸自适应/复制粘贴/主题 |
| `client/ws.ts` | `/term-io` 客户端：单连接多路复用、断线重连、帧分发 |
| `client/rpc.ts` | `/term-manager` RPC 客户端（fetch 封装） |
| `client/store.ts` | 可见性 + 聊天宽度（含 `getEffectiveChatWidth` 动态）+ 布局 + 未读 |
| `client/styles.ts` | 全局 `.tm-` 前缀样式（用 DSH `--dsw-*` token，**非 CSS Modules**） |

### 测试与脚本

- `tests/`：165 项 vitest（含 `mock-device.spec.ts` 退格钳制、`remotes-http.spec.ts`、`ws-io` 容错等）。
- `scripts/mock-device.mjs`（Telnet 路由器 CLI，退格钳制）、`scripts/mock-ssh-device.mjs`（SSH 路由器 CLI）、`scripts/smoke-e2e.mjs`（19 场景冒烟）。

## 工作顺序（M0–M5，均已完成）

M0 脚手架与垂直切片 ✅ ｜ M1 方案 + GUI 选型 ✅ ｜ M2 连接核心（B1–B5/B8）✅ ｜ M3 Agent 工具面（B6/B7a）✅ ｜ M4 数据面 + GUI（B7b + F1–F6）✅ ｜ M5 收尾 + 验收 ✅。详细里程碑内容见 git 历史。

## 后续待办（原 `docs/connections-panel-upgrade.zh.md` 剩余项 + 其他）

- **localEcho 接通 xterm**：配置已存后端，终端 onData 回显未接（中等复杂度）。
- **Telnet 自动登录**：账号/密码/提示正则/超时/延迟。
- **会话信息弹窗**：协议/状态/换行/回显/会话 ID。
- **导入/导出** CSV/JSON 连接配置。
- **收藏分组/搜索**。
- **凭据加密**：接 DSH `ctx.credentials`，替明文 JSON。
- **SSH 主机密钥 TOFU**：首次信任 + known-hosts。
- **Serial 串口**：`SerialTransport` 接口已留。
- **递归分屏**：tmux/iTerm2 式可拖动分屏树（现简单网格）。
- **eval 自动化**：`evals/scenarios.md` 24 条接 CI。
- **真机联调**：Telnet 协商、SSH 跳板机。
- **OSC 52**：远程 vim/tmux 经 SSH 操控本地剪贴板。

## 证据

- `tests/` 165 项全绿；`pnpm build` 产出 host + client 双半包；覆盖率阈值 72/72/60/74。
- 真实启动冒烟：DSH profile tm-dev，`/plugins/dsh-terminal-manager/client.js` 200 + 首页含 `dsh-terminal-manager` 行。
- `scripts/smoke-e2e.mjs` 19 场景对活服务。
