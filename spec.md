# DSH Terminal Manager — 需求与设计规格

- 派生自：`intent/intent.md`（Accepted，commit `453beb6`）
- 作者：Claude Code（agent）+ 产品负责人
- 状态：草稿（Draft）
- 日期：2026-08-25

## 需求

### 功能性

| 编号 | 需求 | 来源 |
|---|---|---|
| F1 | 支持 SSH 连接（密码 + 密钥两种认证）与 Telnet 连接（裸 TCP） | intent |
| F2 | 手动配置连接（名称、协议、IP、端口、用户名、凭据），持久保存于本地 | intent |
| F3 | 点击连接即打开对应终端窗口，实时显示输出 | intent |
| F4 | 同时保持 < 10 个会话，多窗格同屏实时展示各自输出流 | intent |
| F5 | 向指定会话发送指令；向全部打开的会话广播指令 | intent |
| F6 | DSH Agent 通过工具 API：打开/列出/关闭会话、发送指令并拿到完整输出回传 | intent |
| F7 | Agent 发送默认等待命令执行完成（静默期/提示符/超时三重判定）后整段返回；也可读取当前缓冲区快照 | 开放问题 6 结论 |
| F8 | 全部能力以 DSH 插件形态交付，纯本地运行，不引入 MCP 等外部中间件 | intent 约束 |

### 非功能性

- **性能**：10 个并发会话下，设备输出到屏幕显示延迟 < 100ms（本机回环）；单会话输出环形缓冲上限 1 MiB，总内存占用可控。
- **可靠性**：设备断连自动标记会话状态；重连是显式动作，不做静默自动重连。
- **安全**：
  - 数据面 WebSocket 仅接受 client-connection 同款信任栅栏（loopback / trustedHosts）内的请求。
  - 凭据本地明文保存（产品负责人已接受的风险），文件权限 600；文档明示该风险。
  - MVP 阶段 SSH 主机密钥不做严格校验（接受任意主机密钥并在界面显示指纹），在文档与界面标注；TOFU（首次信任）列为后续项。
- **可维护性**：对 DSH 的集成面最小化（见「设计 · 关键决策」），以耐受开发者预览期的破坏性变更。
- **UI**：React 18 + CSS Modules，无组件库；随 DSH 明暗主题；中文文案为主（随 `ctx.locale` 注册 zh/en）。

## 设计

### 总体架构

```
┌──────────────────────────── DSH host 进程（本地） ────────────────────────────┐
│                                                                              │
│  dsh-terminal-manager（host 半）                                              │
│  ├─ ConnectionStore   连接配置的增删改查 + 本地 JSON 持久化                      │
│  ├─ SessionManager    活跃会话注册表（状态机 + 环形缓冲 + 完成判定等待器）          │
│  ├─ SshTransport      ssh2 shell 通道（密码/密钥认证）                          │
│  ├─ TelnetTransport   net.Socket 裸 TCP                                       │
│  ├─ ctx.tools：tm_connect / tm_send / tm_send_all / tm_read / tm_list /      │
│  │              tm_disconnect（Agent 工具面）                                  │
│  ├─ ctx.typert.remotes：termManager 服务（浏览器控制面：配置 CRUD、连接、发送）    │
│  └─ ctx.webServer.registerUpgrade('/term-io')：数据面 WS（输入/输出字节流）      │
│                                                                              │
└──────────────▲───────────────────────────────────────▲───────────────────────┘
        控制面 RPC（/api，typert remotes）         数据面 WebSocket（/term-io）
┌──────────────┴───────────────────────────────────────┴───────────────────────┐
│  dsh-terminal-manager（浏览器半，ctx.slots 挂载）                               │
│  ├─ 侧边栏入口（'sidebar.footer.action' slot）→ 终端工作区面板                    │
│  ├─ 连接管理：列表 + 表单（协议/地址/端口/认证）+ 状态徽标                         │
│  ├─ 终端网格：每会话一个 xterm.js 实例，WS 流式输入输出                            │
│  └─ 广播栏：指令输入 + 目标选择（全部/子集）+ 发送                                 │
└───────────────────────────────────────────────────────────────────────────────┘
                    │ 插件通过 Cordis 挂载，不 patch DSH 核心 │
```

### 关键决策（与备选方案）

**D1：不复用 `ctx.terminals`，插件自持 SessionManager。**
`ctx.terminals` 的语义是「以精确 Agent 为 owner 的本机 PTY」：`spawn` 请求（`type/name/cwd`）没有承载连接参数的字段；`signal/pid/进程树`等概念对网络会话无意义；GUI（人）发起的会话没有 Agent owner，而 owner 校验会拒绝非 owner 操作。这与「人在 GUI 连接、Agent 随后操作同一会话」的核心场景直接冲突。
备选：注册 `ssh`/`telnet` backend 到 `ctx.terminals`——被否（上述三点）。
代价：放弃复用 `tool-terminal` 的六个工具，自建 `tm_*` 工具；工作量可控（会话生命周期比 PTY 简单）。
收益：会话对人和 Agent 同等可见；连接参数一等公民；不受 PTY 语义牵制。

**D2：控制面与数据面分离。**
控制面（配置、连接、状态、Agent 工具）走 DSH 既有 `/api` RPC（`ctx.typert.remotes.register` 注册 `termManager` 服务，浏览器半经 `ctx.remote.termManager.*` 调用）。数据面（终端字节流）走插件自注册的 WebSocket upgrade 路由 `/term-io`（`ctx.webServer.registerUpgrade`，参照 `client-connection` 的信任栅栏），单条连接多路复用，帧带 `sessionId`。
理由：终端流是高频小包，HTTP RPC 往返不适合；DSH 既有的 `MUX_EVENTS` 下行通道属于框架事件总线，不应被插件字节流污染。

**D3：完成判定三重机制（F7）。**
`tm_send` 默认 `wait: 'complete'`：发送后等待以下任一条件满足即返回整段输出——
① 静默期：连续 `quietMs`（默认 500，可配）无新输出；
② 提示符：输出末尾匹配连接级可配置的 `promptPattern`（正则，如 `[\w.-]+[>#]\s*$`）；
③ 超时：`timeoutMs`（默认 30000）兜底。
返回 `{ output, waitReason: 'quiet'|'prompt'|'timeout', truncated }`，Agent 可据 `waitReason` 判断置信度。`wait: 'immediate'` 只提交输入立即返回，配合 `tm_read` 取缓冲区快照（长命令观察场景）。

**D4：打包为「双半包」单一 npm 包。**
一个包同时声明 `dsh.bundle`（host 半：`cordis.patch.yml` 插入插件行）与 `dsh.client`（浏览器半：参照 `ui-cordis` 的 manifest 形态，platform: web）。开发与分发路径遵循官方 `docs/user/develop/basic/`：
- 开发：在 deepseek-harness 源码检出上用 `pnpm dsh web --patch <绝对路径 cordis.yml>`，或 `dsh plugin --profile <p> add ./terminal-manager`（link 安装）；
- 分发：`dsh plugin add ./terminal-manager-<ver>.tgz`（tarball，无需构建授权）；后续可发布 npm。

### 模块与接口

#### 1. ConnectionStore（host 半）

```ts
interface ConnectionConfig {
  id: string                     // 插件生成的稳定 id
  label: string                  // 显示名（唯一）
  protocol: 'ssh' | 'telnet'
  host: string
  port: number                   // SSH 默认 22，Telnet 默认 23
  username?: string              // SSH 必填
  auth?:                         // SSH：password | key；Telnet：无
    | { kind: 'password'; password: string }
    | { kind: 'key'; privateKey: string; passphrase?: string }
  promptPattern?: string         // 完成判定②的正则源
  quietMs?: number               // 完成判定①，默认 500
}
```

- 持久化：`$DSH_HOME/terminal-manager/connections.json`（明文，0600）。
- 对外（remotes `termManager`）：`connections.list/get/create/update/remove`。

#### 2. SessionManager（host 半）

- 状态机：`connecting → open → closed`（含 `error` 关闭原因）。
- 每会话：transport 句柄、1 MiB 环形缓冲（按行可分页读取）、等待器队列、订阅者集合。
- 操作：`connect(connId)` / `disconnect(sessionId)` / `send(sessionId, text, submit)` /
  `broadcast(text, targets?)` / `read(sessionId, {offset,count})` / `sendAndWait(sessionId, text, opts)`（D3 三重判定）/ `list()`。
- 每会话最多一个进行中的 `sendAndWait`（独占，语义对齐 `TerminalSendOperation`）；并发发送请求直接报错，Agent 提示词中说明。
- 输出事件同时推给：数据面 WS 订阅者（实时渲染）与环形缓冲（回放/读取）。

#### 3. 传输层

- `SshTransport`：`ssh2.Client` → `conn.shell()` 流；`readyTimeout` 15s；`hostVerifier: () => true`（MVP，指纹另行通过 `hostKeys` 事件采集展示）；窗口尺寸随 `resize` 帧调整（`setWindow(rows, cols)`）。
- `TelnetTransport`：`net.connect`；原样透传字节；`resize` 无操作。连接关闭 = 会话关闭。
- 两者实现同一内部接口 `{ write(data): void; resize?(cols, rows): void; close(): Promise<void>; onData; onClose; onError }`。

#### 4. Agent 工具（`ctx.tools.register(defineTool({...}))`）

| 工具 | 参数 | 返回 |
|---|---|---|
| `tm_connect` | `connId`（已保存连接）**或** `protocol, host, port, username?, password?`（临时连接，不入库） | `{ sessionId, label, protocol, host, port, banner }` |
| `tm_list` | — | `[{ sessionId, label, target, status, openedAt }]` |
| `tm_send` | `sessionId, command, wait?('complete'\|'immediate'), quietMs?, timeoutMs?` | `{ output, waitReason, truncated }` 或 `{ accepted: true }` |
| `tm_send_all` | `command, sessionIds?（缺省=全部 open）, wait?` | `[{ sessionId, output, waitReason }]` |
| `tm_read` | `sessionId, offset?, count?` | `{ text, totalLines, truncated }` |
| `tm_disconnect` | `sessionId` | `{ sessionId, outcome }` |

- 全部经 `defineTool` 注册：`output.schema` 声明规范 JSON，`execute` 遵守 `exec.signal` 取消；
  `tm_send/tm_send_all` 的 `presentCall` 用 `card: 'terminal'`，`presentResult` 返回原始输出卡片。
- 注册 `ctx.systemPrompt.section`（name: `tool:term-manager`）：使用指引——
  「先用 `tm_list` 查看会话；同一会话一次只跑一条命令；`waitReason: 'timeout'` 不代表命令失败，用 `tm_read` 复查。」

#### 5. 数据面协议（`/term-io` WebSocket，JSON 帧）

| 方向 | 帧 |
|---|---|
| 浏览器 → host | `{ kind: 'attach', sessionId }` / `{ kind: 'detach', sessionId }` / `{ kind: 'input', sessionId, data }` / `{ kind: 'resize', sessionId, cols, rows }` |
| host → 浏览器 | `{ kind: 'output', sessionId, data }` / `{ kind: 'status', sessionId, status, reason? }` |

`attach` 时回放环形缓冲尾部（如最近 64 KiB），切换窗格不丢历史。

#### 6. GUI（浏览器半）

- **入口**：`ctx.slots.inject('sidebar.footer.action', ...)` 注册面板按钮（参照 `ui-cordis` 的 `cordis-panel` 模式）。
- **面板三区**：
  1. **连接栏**：连接卡片列表（名称、目标、协议图标、状态徽标：未连接/连接中/已连接/错误），内嵌新建/编辑表单（协议下拉切换字段集）；
  2. **终端网格**：已打开会话按网格排布，每格 = 标题条（名称 + 断开按钮）+ `xterm.js`（`@xterm/xterm` + `@xterm/addon-fit`）；焦点格接收键盘输入发往设备；
  3. **广播栏**（底部固定）：命令输入 + 目标选择（全部 / 多选子集）+ 发送按钮；发送后各终端正常回显结果。
- 主题：跟随 DSH 明暗；终端配色用低饱和中性色板。
- 依赖：`@xterm/xterm`、`@xterm/addon-fit`（仅浏览器半）。

#### 7. 仓库结构

```
terminal-manager/
├── package.json               # dsh.bundle + dsh.client 双 manifest
├── cordis.patch.yml           # host 半插入行（含默认 config）
├── src/                       # host 半
│   ├── index.ts               # name/inject/apply：装配服务、工具、remotes、WS 路由
│   ├── connection-store.ts
│   ├── session-manager.ts
│   ├── wait-policy.ts         # D3 三重判定
│   ├── transport/ssh.ts
│   ├── transport/telnet.ts
│   └── tools.ts               # tm_* defineTool
├── client/                    # 浏览器半
│   ├── index.ts               # apply(ClientContext)：locale、slots、remote 绑定
│   ├── TerminalPanel.tsx      # 面板（连接栏 + 网格 + 广播栏）
│   ├── TermView.tsx           # xterm.js 封装 + WS attach
│   └── *.module.css
├── tests/                     # vitest：store/wait-policy/transport/session/tools
├── intent/intent.md           # 已 Accepted
├── spec.md                    # 本文件
└── plan.md                    # Build 阶段产出（尚未创建）
```

## 应用的标准

- **DSH 插件规范**：`apply(ctx)` + `inject` 声明、effect 自动清理、配置经 `Config` schema（参照 `docs/user/develop/basic/*`）。
- **工具作者规范**：`docs/cookbook/adding-a-tool.md`——参数自动校验、规范 JSON 输出、遵守 `exec.signal`、纯函数 `presentCall/presentResult`、工具不导入 UI 类型。
- **信任栅栏**：数据面路由复用 `client-connection` 的 `isTrustedApiRequest` 模式（loopback 优先、trustedHosts 白名单）。
- **评审标准**：本仓库 `REVIEW.md`。

## 陷阱与风险

1. **【最高风险】外部包的浏览器半装配**：`dsh.client` manifest 如何被宿主客户端构建消费，仓库内只有 `ui-cordis` 等内部包示例。Build 第一步必须先打通「最小浏览器半 → 出现在页面上」的垂直切片，再铺开功能。
2. **DSH 开发者预览破坏性变更**：集成面已最小化（未依赖 `ctx.terminals`/`tool-terminal`）；`peerDependencies` 声明 `workspace:^` 对应版本区间，锁定测试基线。
3. **明文凭据**：产品负责人已接受；实现上保证文件 0600、不出现在任何日志/工具返回/错误消息中；`tm_*` 工具返回值不含凭据字段。
4. **SSH 主机密钥不校验**：MVP 显式接受，界面展示指纹供人工比对；列为首个后续安全项（TOFU）。
5. **完成判定误判**：静默期对持续输出的命令（如 `tail -f`）会一直等到超时——这是预期行为，提示词指引 Agent 对长命令用 `immediate` + `tm_read`；`promptPattern` 可按设备调优。
6. **裸 TCP Telnet**：无协议协商，某些设备回显行为不一致（本地回显/远端回显）；MVP 原样透传，已知可能出现双字符回显，列入已知限制。
7. **广播 + 独占发送**：广播对每个会话串行触发各自的 `sendAndWait`，某会话忙碌时该路返回 `busy`，不阻塞其余会话。

## 开放问题

| 问题 | 处理 |
|---|---|
| `dsh.client` 外部包装配细节 | Build M1 垂直切片验证；参考 `packages/extensions/ui-cordis` + `cordis-client-runner`。负责人：实现者 |
| `$DSH_HOME` 路径解析用哪个框架服务 | Build 时查 `dsh-settings`/boot 是否暴露数据目录服务；否则用环境变量 + 默认值。负责人：实现者 |
| 面板入口是否需要快捷键 | 延后，MVP 不做 |
| SSH 主机密钥 TOFU | 延后到 MVP 后首个安全迭代 |

## 验证计划

**构建期测试（vitest + 回环集成）**
- 单元：`wait-policy` 三重判定的时序用例；`ConnectionStore` 持久化/校验；`SessionManager` 状态机与独占发送。
- 集成：进程内起一个 ssh2 服务端（`ssh2` 自带 Server）+ 本地 TCP echo 服务，跑真实 `connect → send → 完成判定 → read → disconnect` 全链路；断连、超时、忙碌并发路径。
- 工具层：`defineTool` 注册后经测试上下文调用六个 `tm_*`，断言 schema 与返回。
- UI：`pnpm dsh web` 真实启动 + 浏览器截图对比（连接、开终端、广播三个画面）；xterm 渲染冒烟。

**验收演示（对照 intent 的「期望结果」）**
1. 新建两条连接配置 → 点击连接 → 两个终端出现并实时输出；
2. 广播一条命令 → 两个终端同时回显；
3. 让 DSH Agent 执行「连接 A，跑 `<命令>`，告诉我结果」→ Agent 调 `tm_connect/tm_send` 并汇报输出。

**Eval 套件（Test 阶段）**
将上述演示写成 20+ 条 agent eval：单会话收发、广播、超时复查、断连重连、错误凭据报错形态等。
