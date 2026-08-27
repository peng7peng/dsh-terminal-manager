# 交接文档 — DSH 终端管理插件（terminal-manager）

- 写于：2026-08-27（M5 全面测试 + UI 打磨完成）
- 目的：让接手的 AI 不翻车地继续干下去。**先读完本文，再动任何代码。**

---

## 1. 这个项目是什么（30 秒版）

给 DeepSeek Harness（DSH，路径 `../deepseek-harness`）写一个**终端管理插件**：
- 人和 AI **共用同一批**远程终端（SSH / Telnet），互相看得见、接得上手；
- 界面嵌在 DSH Web UI 右侧工作区（双页签：终端 / 连接）；
- 用户是**芯片验证团队**，真实设备包括网络设备（含 ESL 环境）、未来的芯片串口。

**流程**：本项目按 AI-native SDLC 流程推进（intent → spec → plan → 里程碑门），每个阶段有人工审批门，**未获用户批准不进入下一阶段、不写下一阶段代码**。所有文档和对话用**中文**，跟用户说话要**说人话**（用户有 C++/Python 基础，不懂 TS，讨厌堆术语）。

## 2. 里程碑进度

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 垂直切片 | ✅ | 双半包打包通了：host 半加载、浏览器半出现在页面。验证方式见 §6 |
| M1 方案 + 选型 | ✅ | 方案文档定稿（v4）；界面选型 = `prototypes/full-view-bc.html`（B 卡片式 + C 状态条混搭），结论在 `prototypes/SELECTION.zh.md` |
| M2 连接核心 | ✅ | B1/B2/B3/B4/B5/B8 全部落地，64 项测试全绿（`pnpm test`） |
| M3 AI 工具面 | ✅ | B6 六个 tm_* 工具 + B7a 指令通道；AI 调用端到端验证通过（连设备+发命令+拿回结果）|
| M4 真界面 | ✅ | 前端 6 模块 + B7b 数据流通道；v4 式聊天/终端并排可拖动；本地模拟设备 + AI 调用全链路验证 |
| M5 收尾 | ✅ | 24 条 eval 种子 + README/已知限制 + 健壮性审查（WS 重连/掉线/ctx.effect 陷阱）|

## 后续（MVP 之后）

- **串口**：第一个扩展项，`SerialTransport` 实现已留接口（传输层 `src/transport/types.ts`）。
- **递归分屏**：v4 的 tmux/iTerm2 式可拖动分屏树（现在是简单网格），`client/TerminalWorkspace.tsx`。
- **eval 自动化**：把 `evals/scenarios.md` 的 24 条接 CI（`claude -p` + 断言），防回归。
- **真机联调**：连真实网络设备/ESL 验证 Telnet 协商、SSH 跳板机（接缝见方案 3.8）。
- **凭据加密**：接 DSH 的 `ctx.credentials` 服务，替掉明文 JSON。
- **SSH 主机密钥 TOFU**：首次信任 + 指纹核对。

## 3. 项目已完成（M0–M5 全绿）

MVP 交付：人 + AI 共用 SSH/Telnet 终端，端到端验证通过（本地模拟设备 + AI 调 `tm_*` 拿回结果）。后续扩展项见上面「后续（MVP 之后）」。

**关键实现落点**（改代码前先看这里）：
- host 半入口 `src/index.ts`：装配 ConnectionStore + SessionManager + 工具 + `/term-manager` 路由 + `/term-io` WS。
- 指令通道 `src/remotes.ts`：**直连 `webServer.register` 前缀路由**（绕开 `connection.rpc.handle` 的 ctx 作用域问题 + `intercept('/api')` 与 api-gateway 冲突）；OPTIONS 预检必处理。
- 数据流通道 `src/ws-io.ts`：`ctx.effect(() => webServer.registerUpgrade(...))`（注意 ctx.effect 语义——见 CLAUDE.md 第 6 条）。
- 客户端 `client/`：xterm + WS + 插槽；布局用 `useFrameLayout` 强制 DSH frame 网格成 `sidebar 聊天宽 0px`（聊天收窄、终端占右侧、可拖动分隔条）。

## 4. 关键共识（别推翻，推翻先问用户）

- **架构**：双半包。后端 = DSH host 进程内的 8 个模块（B1–B8），前端 = 浏览器 6 模块（F1–F6）。总图见 `docs/solution.zh.md` 3.0。
- **公共会话池**：不用 DSH 自带 `ctx.terminals`（那是 AI 私有的本机 PTY）；会话归插件的 `SessionManager` 统一持有，人和 AI 走同一个池子。这是用户核心诉求"人机双向平等"的落点。
- **SSH**：ssh2 库 + `conn.shell()` PTY（不用 exec）；MVP 接受任意主机密钥（风险已记录）。
- **Telnet**：裸 TCP 定案（用户确认设备以网络设备/ESL 为主）；协商接缝已留。
- **完成判定**：静默 500ms / 提示符正则可选 / 超时 30s；优先级 提示符 > 静默 > 超时；无输出时只有超时生效。参数表和范围见方案 3.4。
- **广播**：逐台独立、互不阻塞；结果四种：ok / busy / disconnected / error。
- **命令守卫（B8）**：只拦 AI 发起的发送，人的键盘输入不拦；默认黑名单 + 按连接白名单；命中返回 `COMMAND_BLOCKED`。用户已确认此策略。
- **订阅 ≠ 会话**：关页面只断"看"（订阅随 WS 管道生灭），不断"连"；心跳 30s。见方案 3.5。
- **串口**：不进 MVP，交付后第一个扩展项（用户拍板）。
- **界面**：页签结构、状态条交互（芯片点选显隐、✕ 断开分离）、表单必填/选填规则——全部在 `prototypes/SELECTION.zh.md`，**实现以它和 full-view-bc 原型为准**。
- **错误格式**：`{ code, message }`，message 永不带密码/密钥内容。错误码表见方案 3.6。

## 5. 待确认项（问用户，别自己猜）

| 项 | 状态 |
|---|---|
| 跳板机/堡垒机 | 用户暂不确定；卡住联调再启动扩展（方案 3.8 有接缝） |
| AgentTerm 参考 | 用户说"后续口头描述"其 SSH/Telnet 连接设计（用户习惯），影响 M4 表单——M4 开工前问一次 |
| 灵枢平台 MaaS 绑定 | 1.1 第 3 条需求，用户挂起未解释；不阻塞 |
| 设备提示符形态 | 联调时观察；已定策略：预置网络设备常见提示符模板按连接选用 |

## 6. 环境与命令（踩过的坑都在这）

```sh
cd /d/myProject/dsh/terminal-manager   # 本仓库
pnpm build      # tsdown：lib/index.js（host 半）+ lib/client.js（浏览器半工厂包）
pnpm test       # vitest，64 项全绿是基线；改挂了必须修绿再提交
```

- **运行验证**：在 `../deepseek-harness` 下 `pnpm dsh --profile tm-dev --port 3180 --no-open`
  - profile 在 `~/.dsh/profiles/tm-dev`（bundles：dsh-base、dsh-web-app、本插件）
  - **3080 被用户自己的 DSH 占用，别动它**，验证一律用 3180
  - 健康判据：`/plugins/dsh-terminal-manager/client.js` 返回 200；首页 `__DSH_BOOT__` 含 `dsh-terminal-manager` 行
- **坑清单**：
  - Windows 上 node 不吃 `/d/...` 路径，脚本里用 `D:/...`；`/tmp` 对 node 不存在
  - pnpm 11 的构建豁免写在 `pnpm-workspace.yaml` 的 `allowBuilds:`（本仓库：cpu-features/ssh2 = false，走纯 JS，**别开原生构建**）
  - `pnpm add` 后若有 ERR_PNPM_IGNORED_BUILDS 是警告不是失败（除非 deps-status check，见 allowBuilds）
  - 写 ssh2 测试服务器：必须处理 `session.on('pty', accept)`，否则客户端 `shell()` 报 "Unable to request a pseudo-terminal"
  - DSH 没有 `ctx.router`/`ctx.ws`；路由用 `ctx.webServer.register/registerUpgrade`，参考 `packages/client/connection/src/index.ts`
- 本仓库依赖 `@deepseek-ai/*` 用 `link:` 指向相邻 deepseek-harness 检出（版本严格一致）；客户端基线外部依赖表在 `tsdown.config.ts`。

## 7. SDLC 流程与协作习惯

- **产物链**：`intent/intent.md`（已接受）→ `spec.md`（已批准）→ `plan.md`（已批准）→ `docs/solution.zh.md`（v4，主方案，**改设计先改这里**）→ 里程碑门。
- **门规则**：阶段产物提交后找用户审批；用户是产品负责人，风格：细、爱追问"为什么"、要求说人话、文档必须中文。
- **用户活跃**：会自己在仓库里加原型文件（`prototypes/redesign-*.html`）、直接改文档（留意文件变动提示，别覆盖回滚）。
- 实现偏离计划/方案时：同提交更新 `plan.md` 或 `docs/solution.zh.md`，并在汇报里说明。
- 提交信息用中文，写清楚里程碑和模块编号（如 `M3: B6 工具层落地…`）。
- 有外部评审意见进来时：逐条判定（采纳/已设计/纠正），落进文档再动手。

## 8. 仓库地图

```
terminal-manager/
├── HANDOVER.zh.md            # 本文
├── intent/intent.md          # 意图（已接受）
├── spec.md                   # 规格（已批准）
├── plan.md                   # 计划（已批准；M2 段已更新）
├── CLAUDE.md                 # 仓库记忆（命令/约定/坑）
├── docs/solution.zh.md       # 主方案 v4（架构/模块/参数/行为约定）
├── prototypes/               # 原型 + SELECTION.zh.md 选型结论
├── src/                      # 后端：B1 connection-store / B2 transport/ssh / B3 transport/telnet
│                             #        B4 session-manager / B5 wait-policy / B8 command-guard
│                             #        （M3：tools.ts + remotes.ts；M4：ws-io.ts）
├── client/                   # 前端（M4 重写为真实实现；现为 M0 最小片）
└── tests/                    # 64 项；helpers.ts = 模拟设备工厂
```
