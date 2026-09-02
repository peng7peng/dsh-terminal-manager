# DSH Terminal Manager — 需求与设计规格

- 派生自：`intent/intent.md`（Accepted，commit `453beb6`）
- 作者：Claude Code（agent）+ 产品负责人
- 状态：已批准（Approved）— 2026-08-25
- 日期：2026-08-25
- 2026-08-28：本文件合并了原 `docs/solution.zh.md`（v4，随 M1 定稿），为**唯一设计源**（requirements + design + gotchas + verification）；原方案文档已归档至 `docs/archive/solution.zh.md`
- 2026-09-02：九月迭代开工。新增「模块间契约（`src/types/`）与扩展模块」一节（两人分支并行的接口冻结）与 B9 事件总线；九月新功能（文件面板 / 浮动编辑器 / TC 执行 / 选中发送 / 文件传输）的设计见仓库外 `../开发过程文档/` 下的「设计方案」与「交互设计」（不入库），实现落地后再并入本文件
- 2026-09-02（下午）：按 S1–S3 开工需要，落地 B10 文件服务（本地）、B11 TC 脚本解析（语法按真实样例改写，原「`N:` 前缀」假设作废）、前端 F7–F11 模块边界、Config 项与文件错误码；决策：同事不新增工作区面板，本地文件面板 / 浮动编辑器 / TC 确认框与汇总条随本轮一起做

## 需求

### 功能性

| 编号 | 需求 | 来源 |
|---|---|---|
| F1 | 支持 SSH 连接（密码 + 密钥两种认证）与 Telnet 连接（裸 TCP 双模式） | intent |
| F2 | 手动配置连接（名称、协议、IP、端口、用户名、凭据），持久保存于本地 | intent |
| F3 | 点击连接即打开对应终端窗口，实时显示输出 | intent |
| F4 | 同时保持 < 10 个会话，多窗格同屏实时展示各自输出流 | intent |
| F5 | 向指定会话发送指令；向全部打开的会话广播指令 | intent |
| F6 | DSH Agent 通过工具 API：打开/列出/关闭会话、发送指令并拿到完整输出回传 | intent |
| F7 | Agent 发送默认等待命令执行完成（静默期/提示符/超时三重判定）后整段返回；也可读取当前缓冲区快照 | 开放问题 6 结论 |
| F8 | 全部能力以 DSH 插件形态交付，纯本地运行，不引入 MCP 等外部中间件 | intent 约束 |

### 非功能性

- **性能**：10 个并发会话下，设备输出到屏幕显示延迟 < 100ms（本机回环）；单会话输出环形缓冲上限 1 MiB（`session-manager.ts` 的 `BUFFER_CAP_BYTES`），总内存占用可控。
- **可靠性**：设备断连自动标记会话状态并即时推送 `status` 帧；重连是显式动作，不做静默自动重连；WS 通道断线自动重连（指数退避，重连后由前端重建终端状态）。
- **安全**：
  - 数据面 WebSocket（`/term-io`）MVP 信任栅栏 = **仅 loopback**（`127.0.0.1` / `localhost` / `[::1]`，见 `ws-io.ts` 的 `isLoopback`）；trustedHosts 白名单列为后续项。
  - 控制面 HTTP（`/term-manager`）**来源围栏**（2026-09-02 起）：`remotes.ts` 的 `isTrustedOrigin`——请求无 `Origin`（同源）、或 `Origin` 是 loopback、或与 `Host` 相同才处理，其余 403；CORS 头只回显被允许的来源，**不再回 `*`**。原因：`files.*` 端点能读写本机文件，通配 CORS 会让互联网网页借浏览器跨源发 JSON POST（CSRF）写任意文件。前端 `fetch` 用相对路径、与页面同源，不受影响。
  - 凭据本地明文保存（产品负责人已接受的风险）；落盘 `connections.json` 权限尽力 0600（Windows 平滑降级）；错误消息/日志/工具返回值**永不含密码或密钥内容**；文档明示该风险。
  - MVP 阶段 SSH 主机密钥不做严格校验（`hostVerifier` 接受任意主机密钥，见 `transport/ssh.ts`）；TOFU（首次信任）+ 指纹核对列为 MVP 后首个安全迭代。
- **可维护性**：对 DSH 的集成面最小化（不依赖 `ctx.terminals` / `tool-terminal`；控制面不用 `ctx.typert.remotes`），以耐受开发者预览期的破坏性变更。
- **UI**：React 18 + xterm.js，无组件库；样式用**全局 `.tm-` 前缀 CSS**（注入单条 `<style>`，无 CSS Modules），配色走 DSH `--dsw-*` token，随 DSH 明暗主题；中文文案为主（随 `ctx.locale` 注册 zh/en）。

## 设计

### 总体架构

```
┌──────────────────────────── DSH host 进程（本地） ────────────────────────────┐
│                                                                              │
│  dsh-terminal-manager（host 半，Cordis 插件，src/）                            │
│  ├─ B1 ConnectionStore     连接配置增删改查 + 本地 JSON 落盘（0600）           │
│  ├─ B4 SessionManager      活跃会话公共池（状态机 + 1MiB 环形缓冲 + 输出分发    │
│  │                          + 独占发送 + 广播）—— 唯一接触传输层的地方          │
│  ├─ B2 SshTransport        ssh2 · shell() PTY（密码/密钥认证）                 │
│  ├─ B3 TelnetTransport     net.Socket · telnet（IAC 剥离）/ raw 双模式          │
│  ├─ B5 WaitPolicy          完成判定（纯逻辑：静默 500ms / 提示符正则 / 超时 30s）│
│  ├─ B8 CommandGuard        命令守卫（黑名单 + 按连接白名单，只拦 AI 路径）       │
│  ├─ B6 ctx.tools          tm_connect / tm_send / tm_send_all / tm_read /      │
│  │                          tm_list / tm_disconnect（Agent 工具面）            │
│  ├─ B7a 控制面             /term-manager 前缀路由（ctx.webServer.register）     │
│  └─ B7b 数据面             /term-io WebSocket（ctx.webServer.registerUpgrade） │
│                                                                              │
└──────────────▲───────────────────────────────────▲───────────────────────────┘
         控制面 HTTP（POST /term-manager/*）    数据面 WebSocket（/term-io）
┌──────────────┴───────────────────────────────────┴───────────────────────────┐
│  dsh-terminal-manager（浏览器半，ctx.slots 挂载，client/）                     │
│  ├─ sidebar.footer.action 入口按钮（「终端管理」）→ 开/关工作区                  │
│  └─ shell.overlay 全屏覆盖层工作区（useFrameLayout 强制 DSH frame 网格为        │
│     「sidebar 聊天宽 0px」，终端占右侧，聊天收窄在左侧）                        │
│       ├─ 终端模块（tm-main）：终端网格（xterm 窗格）+ 广播栏（两行）            │
│       └─ 连接面板（tm-side，右侧并排 300px）：表单 + 活跃会话 + 收藏 + 最近连接  │
└──────────────────────────────────────────────────────────────────────────────┘
                    插件经 Cordis 挂载，不 patch DSH 核心
```

### 场景分解（需求 → 14 个使用场景，映射到模块与测试）

| 编号 | 场景 | 期望结果 | 模块 |
|---|---|---|---|
| S1 | 新建连接 | 表单区分必填/选填（SSH 密码/密钥二选一必填，Telnet 均可选），保存即入库 | F2/B1/B7a |
| S12 | 编辑/删除连接 | 编辑回填表单；删除自动先断开 | F2/B1/B7a |
| S2 | 一键连接 | 点连接 → 状态「连接中→已连接」→ 终端出现并实时输出 | B4/B7a/B7b |
| S3 | 多设备同屏 | 3+ 终端各自实时输出，互不串扰 | B4/B7b/F3/F4 |
| S13 | 隐藏/显示窗格 | 点状态条/列表条目隐藏某终端（不断开）；隐藏后条目变暗 + 虚线边框、名称保留，点击恢复 | F3/F6 |
| S14 | 多终端聚焦 | 超过 3 个终端时，单格最大化/还原 | F3/F4（MVP 以网格自动排布交付，递归分屏列后续） |
| S4 | 手动敲命令 | 按键即达、输出即显（xterm onData → WS input → B4 → 传输） | F4/F5/B4 |
| S5 | 广播到全部会话 | 所有打开的终端同时回显，慢设备不拖慢别人；回显样式与正常终端显示保持一致 | F3/B4 |
| S6 | 广播到部分会话 | 芯片点选目标，按钮显示目标数 | F3 |
| S7 | AI 单机测试 | AI 连接 + 发命令，等执行完拿回整段输出 | B6/B4/B5 |
| S8 | AI 批量测试 | 一条命令广播多设备，逐台返回结果并汇总 | B6/B4/B5 |
| S9 | AI 读现场 | 读取某会话当前屏幕缓冲 | B6/B4 |
| S10 | 人机共视/接管 | AI 跑命令时人实时看见，跑完人接着敲，无两套状态（公共会话池的体现） | B4/B7b |
| S11 | 密码错/不通/掉线 | 明确报错（不泄露密码）、状态可见、可重连 | B2/B3/B4 |

### 关键决策（与备选方案）

**D1：不复用 `ctx.terminals` / `tool-terminal`，插件自持 SessionManager（核心共识）。**
先澄清内置物：`packages/terminal` + `tool-terminal` 是 DSH 自带的「AI Agent 本机终端」能力（`terminal_open` 等六个工具），只能开本机 shell，且会话被「开它的那个 Agent」独占（`spawn(owner: Agent)`，所有操作校验 owner），体系中不存在「人」的位置。
产品负责人的核心要求是**人与 AI 双向平等**：双方都能开终端、AI 能读人开的终端、人能操作 AI 开的终端。这在内置体系中不可达（人开的会话无 Agent owner，Agent 无法触碰；反之亦然）。
因此：会话是插件管理的**公共资产**，不归任何人所有——人经 GUI、AI 经工具，访问同一批会话。备选「注册 ssh backend 到 `ctx.terminals`」被否（除上述原因，`spawn` 请求也无字段承载连接参数）。代价：不复用 `tool-terminal`，自建 `tm_*` 工具。

**D2：控制面与数据面分离，控制面走独立前缀路由 `/term-manager`（不是 typert remotes，也不是 `/api`）。**
- 数据面（终端字节流）：插件自注册 `/term-io` WebSocket upgrade 路由（`ctx.webServer.registerUpgrade`），单条连接多路复用，帧带 `sessionId`。理由：终端流是高频小包，HTTP RPC 往返不适合；DSH 既有的下行事件总线不应被插件字节流污染。
- 控制面（配置、连接、状态、快照）：`ctx.webServer.register({ kind: 'prefix', path: '/term-manager', handler })` 注册**独立前缀路由**（`src/remotes.ts` 的 `registerRemotes`）。**明确不用 `ctx.typert.remotes`**：`connection.rpc.handle` 经 connection 服务的 `ctx.effect` 注册、存在 ctx 作用域问题导致路由进不了 webServer 表；`intercept('/api')` 又与 api-gateway 冲突。客户端 POST 到 `/term-manager/<方法>`（`client/rpc.ts`）。
- 信任栅栏：MVP 仅本机（webServer 本机绑定 + `/term-io` 的 `isLoopback`）即已限。

**D3：完成判定三重机制（F7）。**
`tm_send` 默认 `wait: 'complete'`：发送后等待以下任一条件满足即返回整段输出——
① 静默期：连续 `quietMs`（默认 500ms）无新输出；
② 提示符：输出末尾匹配连接级可配置的 `promptPattern`（正则源，可选）；
③ 超时：`timeoutMs`（默认 30000ms）兜底。
返回 `{ output, waitReason: 'quiet'|'prompt'|'timeout', truncated }`；`wait: 'immediate'` 只提交输入立即返回，配合 `tm_read` 取缓冲区快照（长命令观察场景）。
三个参数均为**技术默认值而非产品决策**：静默期/提示符/超时是每连接的配置项（`ConnectionConfig.quietMs/promptPattern/timeoutMs`），联调真实设备时按设备调整；设备提示符形态未知时先用静默期判定。判定优先级：**提示符 > 静默 > 超时**；尚无任何输出时只有超时生效（防慢响应设备被静默误判）。

**D4：打包为「双半包」单一 npm 包。**
一个包同时声明 `dsh.bundle`（host 半：`cordis.patch.yml` 插入插件行）与 `dsh.client`（浏览器半：`inject` 声明 + `platform: web`）。开发与分发路径遵循官方 `docs/user/develop/basic/`：
- 开发：在 deepseek-harness 源码检出上 `pnpm dsh --profile tm-dev --port 3180`（link 安装）；验证一律用 3180（3080 被用户自己的 DSH 占用）；
- 分发：`dsh plugin add ./dsh-terminal-manager-<ver>.tgz`（tarball）；后续可发布 npm。
- 构建产物：`tsdown` → `lib/index.js`（host 半）+ `lib/client.js`（浏览器半惰性工厂包）；外部分依赖用 `deps: { neverBundle, alwaysBundle }`（`@deepseek-ai/*` 走 link: 基线模块，其余打包内联）。

**D5：GUI 布局 = `shell.overlay` 全屏覆盖层工作区 + 「终端 | 连接面板」左右并排（不是 details 栏，也不是双页签）。**
M1 曾计划挂到右侧 `details` 栏做双页签，垂直切片验证后否决：`details` 栏与「当前聊天会话」绑定（无会话时栏宽为 0、切换会话自动收起），不满足「会话常驻右侧工作区」的要求。定案方案：
- 入口：`ctx.slots.inject('sidebar.footer.action', ...)` 注册侧边栏「终端管理」按钮，点击开/关工作区。
- 容器：`ctx.slots.inject('shell.overlay', ...)` 挂**全屏覆盖层**（`position: fixed`，占满右侧从 `left: 侧栏+聊天宽` 到右缘）。
- 布局：`useFrameLayout`（`client/store.ts`）把 DSH frame 的 `gridTemplateColumns` 强制成 `sidebar 有效聊天宽 0px`（详情列压 0 宽），聊天收窄在左侧、终端占右侧，两者之间一条可拖动分隔条。capture/restore 原始 grid 在 `setWorkspaceVisible` 里**同步**完成（不依赖 React effect 时序）。
- 并排：工作区内 `tm-main`（终端模块）+ `tm-side`（连接面板，300px）左右并排，无留白。
- 用户体验细节（见「模块与接口 · F3」）：终端模块未拖动时固定目标宽 480，聊天自动填满左侧；拖动上限随视口动态 `max(760, 视口宽-764)`，大屏可把终端收窄至约 200px。

### 模块与接口

#### B1 ConnectionStore（`src/connection-store.ts`）

```ts
interface ConnectionConfig {
  id: string                    // 插件生成的稳定 id（randomUUID）
  label: string                 // 显示名（唯一）
  protocol: 'ssh' | 'telnet'
  host: string
  port: number                  // 缺省按协议：SSH 22，Telnet 23
  username?: string             // SSH 必填
  auth?:
    | { kind: 'password'; password: string }
    | { kind: 'key'; privateKey: string; passphrase?: string }   // SSH：password | key
  promptPattern?: string        // 完成判定②的正则源（可选）
  quietMs?: number              // 完成判定①（可选，默认 500）
  timeoutMs?: number            // 完成判定③（可选，默认 30000）
  guardWhitelist?: string[]     // 命令守卫白名单（正则源列表，按连接豁免）
  telnetMode?: 'telnet' | 'raw' // Telnet 模式（默认 telnet：完整 IAC 协商）
  handshakeTimeoutSec?: number  // SSH 握手超时秒数（默认 15；可选 15/30/60/120/180）
  newline?: 'lf' | 'cr' | 'crlf'// 行尾换行（默认 'crlf'）
  localEcho?: boolean           // 本地回显开关（默认 false；字段已保存后端）
  note?: string                 // 备注（选填）
  favorited?: boolean           // 收藏标记（UI 置顶显示）
}
```

- 持久化：`$DSH_HOME/terminal-manager/connections.json`（默认 `~/.dsh/terminal-manager/`，可用 `DSH_TERMINAL_MANAGER_DATA` 环境变量覆盖；见 `src/index.ts` 的 `resolveDataDir`）。明文，`fs.chmod` 尽力 0600（Windows 平滑降级）。
- 校验（`StoreValidationError`，消息只描述字段不描述值，永不含凭据）：名称/IP 非空、端口 1–65535、SSH 需用户名 + 认证、promptPattern 须合法正则、quietMs 100–5000、timeoutMs 1000–300000。
- CRUD：`list / get / create / update(id, patch) / remove`；懒加载 `ensureLoaded()`（幂等）。

#### B4 SessionManager（`src/session-manager.ts`）——整个插件的心脏

- 状态机：`connecting → open → closed`（含 error 关闭原因）。
- 每会话（`SessionRecord`）：transport 句柄、1 MiB 环形缓冲（按行可分页读取）、订阅者集合、独占发送标记。会话键为 `sessionId`（randomUUID），快照 `SessionSnapshot = { sessionId, connId?, label, target, protocol, status, openedAtMs? }`。
- 操作：`connect(target, connId?)` / `connectByConnId(connId)` / `disconnect` / `write`（人工键入，不过守卫不排队）/ `sendImmediate`（AI 发完即回，过守卫）/ `sendAndWait`（D3 三重判定 + 独占）/ `broadcast` / `read(sessionId, count=500)` / `list` / `closeAll` / `onStatus`。
- **去重**：同 `protocol:host:port` 的 open 会话直接复用（临时连接与 connId 连接共用同一池）；`connectByConnId` 对同一 `connId` 的未关闭会话直接返回既有会话。
- **独占发送**：每会话最多一个进行中的 `sendAndWait`，并发发送直接抛 `SESSION_BUSY`；广播对每台独立执行。
- **完成判定**：`resolveWaitConfig` 合并连接级 `quietMs/promptPattern/timeoutMs` + 调用覆盖参数；`WaitPolicy` 每轮 50ms 轮询（`POLL_INTERVAL_MS`）。换行：`sendAndWait`/`sendImmediate` 经 `eolOf` 取行尾——优先调用参数 `newline`，其次连接配置 `conn.newline`（实时回读），再次会话建立时的记录值（临时连接），缺省 `crlf`；`submit` 缺省 true。
- **输出分发**：`handleData` 同时写环形缓冲 + 推给所有订阅者（订阅者 = WS 连接，推给它挂着的那条 `/term-io` 管道）；连接终结 `handleClose` 标记会话为 `closed`（被动断开，保留会话以供重连）并 `notify` 状态帧。
- **命令守卫**：`SendOptions.guard` 传入时才启用（AI 路径必传），合并连接级 `guardWhitelist` + 调用方规则；命中抛 `COMMAND_BLOCKED`。
- **重连**：`reconnect(sessionId)` 仅对 `closed` 状态会话有效，清理旧 transport 后重建连接，sessionId 保持不变；失败则恢复为 `closed`。
- **主动断开**：`disconnect(sessionId)` 标记会话为 `removed` 并从会话池删除，前端据此移除该会话；连接配置（收藏）保留。
- 卸载时 `ctx.effect` 清理全部会话（`closeAll`）。
- **公开面**：`SessionManager implements SessionManagerApi`（契约 `src/types/session-api.ts`）；数据类型（`SessionSnapshot`/`SendOptions`/`ConnectTarget` 等）正式定义也在契约文件，`session-manager.ts` re-export 保持老 import 路径。
- **事件埋点（B9）**：`handleData` → `output`；`write` → `input(source='human')`；`sendImmediate`/`sendAndWait` → `input(source = options.source ?? (有 guard ? 'ai' : 'human'))`；`broadcast` 缺省 `source='broadcast'`（带 guard 为 `'ai'`）；`notify` → `status`（带完整快照）。总线由构造函数第三参注入，缺省自建。

#### B9 EventBus（`src/event-bus.ts`，契约 `src/types/events.ts`）

- `createEventBus()`：同步派发；`on(handler, filter?)` 按 `type`（单个或数组）/ `sessionId` 过滤，返回取消函数；订阅者抛错被吞掉并 `console.error`，主链路不受扩展模块影响。
- 事件：`output` / `input`（含 `source: 'human'|'ai'|'script'|'broadcast'`）/ `status`（含 `snapshot`）/ `file`（传输结束，M5 起由文件服务派发）。
- 消费者：日志管理模块（落盘）、共享端口模块（旁观）；主线自身不依赖它（`onStatus`/`subscribe` 仍是前端与工具的路径）。

##### 连接与会话的状态机（产品设计）

**核心概念**：
- **收藏（Favorite）** = 连接配置（`ConnectionConfig`，持久化于 `connections.json`）
- **会话（Session）** = 运行时实例（`SessionRecord`，内存中，DSH 重启即丢失）
- 每个收藏**最多对应一个活跃会话**（通过 `connId` 关联）

**会话状态**：
- `connecting`：正在建立连接
- `open`：已连接，可交互
- `closed`：被动断开（网络问题/设备掉线），保留会话以供重连
- `removed`：主动断开（用户点✕），会话已删除

**UI 行为矩阵**：

| 组件 | 状态 | 显示 | 用户操作 |
|------|------|------|---------|
| **收藏卡片** | 无会话 | 连接配置信息 | 点击 → 创建新会话 |
| **收藏卡片** | 有 `open` 会话 | 绿色状态点 | 点击 → 聚焦该会话 |
| **收藏卡片** | 有 `closed` 会话 | 灰色状态点 | 点击 → 重连该会话 |
| **收藏卡片** | 有 `removed` 会话 | 连接配置信息 | 点击 → 创建新会话 |
| **活跃会话卡片** | `open` | 正常显示 | 点击 → 切换显示/隐藏 |
| **活跃会话卡片** | `closed` | 「已断开 - 点击重连」 | 点击 → 重连该会话 |
| **终端窗口** | `open` | 正常终端 | 正常交互 |
| **终端窗口** | `closed` | 「已断开」覆盖层 + ✕ 按钮 | 点 ✕ → 移除会话 |

**设计原则**：
1. **终端窗口只负责显示和交互**，不负责连接管理（无重连按钮）
2. **连接管理集中在会话卡片**（重连、断开等操作）
3. **收藏卡片智能路由**：根据会话状态决定创建/聚焦/重连
4. **被动断开保留会话**：网络问题后可重连，用户体验连续
5. **主动断开清除会话**：用户明确意图，不保留幽灵会话
6. **DSH 重启后清空前端状态**：WebSocket 重连后从后端重新拉取会话列表，避免显示已丢失的会话
7. **同一目标去重**：多个连接配置指向同一目标（protocol:host:port）时共享会话，前端先按 connId 精确匹配，找不到再按目标模糊匹配，避免创建重复终端窗口

**会话去重与协议隔离**：

去重键为 `protocol:host:port`，意味着：
- **同协议同目标**（如两个 Telnet 配置都连 127.0.0.1:2323）→ 共享会话，复用同一 TCP 连接
- **不同协议同目标**（如 Telnet:2323 和 SSH:2323）→ 独立会话，各自建立独立 TCP 连接

**原因**：
- Telnet 和 SSH 是完全不同的协议，服务器端由不同的守护进程处理
- 每个 TCP 连接在服务器端是独立的会话（通过四元组识别：源IP、源端口、目标IP、目标端口）
- 服务器不会在 Telnet 和 SSH 会话之间共享状态（除非特殊配置）
- 用户可能需要在同一台设备上同时用 Telnet 和 SSH 测试不同场景

#### B2/B3 传输层（`src/transport/`，接口见 `types.ts`）

内部接口 `Transport { write(data): void; resize?(cols, rows): void; close(): Promise<void> }` + 回调 `TransportCallbacks { onData(utf8 chunk), onClose(reason) }`；统一的 `TransportError`（`AUTH_FAILED` / `HOST_UNREACHABLE` / `CONN_TIMEOUT` / `PROTO_ERROR` / `DISCONNECTED`）。传输层只被 B4 接触。

- **SshTransport**（`ssh.ts`）：`ssh2.Client` → `conn.shell({ term: 'xterm-256color', cols, rows })` 交互通道（带 PTY）；stderr 也并入数据流。`readyTimeout` = `connectTimeoutMs`（来自连接级 `handshakeTimeoutSec`，默认 15s，UI 可选 15/30/60/120/180）；`hostVerifier: () => true`（MVP 接受任意主机密钥）。`resize` → `channel.setWindow(rows, cols)`。连接失败时不触发 `onClose` 回调（通过 `connected` 标志位判断），避免产生幽灵会话。
- **TelnetTransport**（`telnet.ts`）：`net.connect`。`telnetMode: 'telnet' | 'raw'`：
  - `telnet`（默认）：**完整 IAC 协商**——连接时主动发送 WILL ECHO + WILL SGA + DO SGA + DO ECHO；响应服务器的 DO/WILL 请求（DO SGA → WILL SGA, DO ECHO → WILL ECHO, DO TTYPE → WILL TTYPE 等）；支持子协商（TTYPE 响应发送 "xterm"，NAWS 在 resize 时发送窗口尺寸）；状态机解析器处理 IAC 序列，支持跨 chunk 拼接。
  - `raw`：裸 TCP 透传字节（`chunk.toString('utf8')`），不做任何协议处理，适合串口服务器/ESL。
  - `resize` 在 telnet 模式下发送 NAWS 子协商；raw 模式无操作。

#### B5 WaitPolicy（`src/wait-policy.ts`）

纯逻辑、无 I/O、无定时器（由 B4 驱动 `feed()`/`poll()`）。`WaitPolicyConfig { quietMs?, promptPattern?, timeoutMs?, outputCapBytes? }`。返回 `waitReason: 'quiet' | 'prompt' | 'timeout'`；累计输出超 256KB 截断并标记 `truncated`。边界：quietMs 100–5000、timeoutMs 1000–300000。

#### B8 CommandGuard（`src/command-guard.ts`）

纯逻辑。默认黑名单（`DEFAULT_DANGEROUS_RULES`，大小写不敏感）：`rm -rf /` 类、`mkfs*`、`dd of=/dev/…`、`shutdown|reboot|halt|poweroff`、`init 0`、fork 炸弹。`GuardOptions { extraRules?, whitelist? }`，白名单优先豁免（含连接级 `guardWhitelist`）。**只检查 AI 发起的发送**（`tm_send`/`tm_send_all`，`guard` 参数）；人的键盘输入不经过它。

#### B6 AI 工具层（`src/tools.ts`）——AI 的六只"手"

全部经 `defineTool` 注册到 `ctx.tools`，`execute` 遵守 `exec.signal` 取消；AI 路径发送必传 `guard: {}`。注册 `ctx.systemPrompt.section`（name: `tool:term-manager`）：「先用 tm_list 查看会话；同一会话一次只跑一条命令；waitReason: 'timeout' 不代表命令失败，用 tm_read 复查；危险命令会被拦截」。`presentCall` 用 `card: 'generic'`（`tm_send` 例外为 `card: 'terminal'`），`presentResult` 返回原始输出卡片。

| 工具 | 参数 | 返回 |
|---|---|---|
| `tm_connect` | `connId`（已保存连接）**或** `protocol,host,port?,username?,password?,label?`（临时连接，不入库） | `SessionSnapshot` + `banner`（读缓冲尾部 200 行） |
| `tm_list` | — | `SessionSnapshot[]` |
| `tm_send` | `sessionId, command, wait?('complete'\|'immediate'), quietMs?, timeoutMs?` | `{ kind:'completed', output, waitReason, truncated }` 或 `{ kind:'submitted' }` |
| `tm_send_all` | `command, sessionIds?`（逗号分隔串，缺省=全部 open）, `wait?` | `[{ sessionId, outcome:'ok'\|'busy'\|'disconnected'\|'error', output?, waitReason?, code? }]` |
| `tm_read` | `sessionId, count?`（缺省 500） | `{ text, totalLines, truncated }` |
| `tm_disconnect` | `sessionId` | `{ sessionId, outcome:'closed' }` |

#### B7a 控制面指令通道（`src/remotes.ts`）——/term-manager 前缀路由

- 挂载：`registerRemotes(ctx, deps)` → `ctx.effect(() => webServer.register({ kind: 'prefix', path: '/term-manager', handler }))`。⚠️ `ctx.effect(fn)` 的 fn 是 setup、返回值是清理函数——把 `webServer.register(...)` 的 disposer 直接当 fn 传会立即删掉路由（405）。绕开 `connection.rpc.handle`（ctx 作用域问题）与 `/api`（api-gateway 冲突）。
- `createHttpHandler(deps)`（可独立单测）：
  - `OPTIONS` 预检 → `204` + `access-control-allow-origin: *` + `allow-methods: POST, OPTIONS` + `allow-headers: content-type`；
  - 非 POST → `405`；
  - 坏 JSON → `400`（返回 `bad-request`）；
  - POST → 解析 `{ type: 'client-request', rpcId, method, payload }`，endpoint 取 body.method 或 URL 路径，经纯函数 `dispatch(endpoint, payload, deps, signal)` 调度，返回 `{ type: 'server-response', rpcId, result }`。
- 端点：
  - `connections.list` / `connections.create` / `connections.update({id, patch})` / `connections.remove({id})`
  - `sessions.list` / `sessions.connect`（`connId` 或临时连接字段：`protocol,host,port,username,password,label,telnetMode,connectTimeoutMs,newline,localEcho`）/ `sessions.disconnect({sessionId})` / `sessions.reconnect({sessionId})` / `sessions.read({sessionId, count?})`
- 错误折叠：领域异常 → `RpcResult.error`，其中 HTTP 层 `code` 统一为 `internal`、领域 code 编进 message（`{ code, message }` 格式，message 永不含凭据）；`AbortSignal` 已中止 → `cancelled`；未知端点 → `internal`（message 带端点名）。

#### B7b 数据面数据流通道（`src/ws-io.ts`）——/term-io WebSocket

- 挂载：`registerWsIo` → `ctx.effect(() => webServer.registerUpgrade({ path: '/term-io', handler }))`；卸载时清心跳、关全部连接、清订阅。
- 上行帧：`attach / detach / input / resize`（均带 `sessionId`）；下行帧：`output { sessionId, data }` / `status`（`{ kind:'status' } & SessionSnapshot`，会话状态变化即推全量快照）。
- `TermIoConnection`：attach 登记「该会话输出 → 本管道」的订阅；detach/关闭时逐条退订。**订阅随连接生灭**：WS 关闭 → 清掉该连接挂的所有订阅。MVP 信任栅栏 `isLoopback`（仅 127.0.0.1 / localhost / ::1）。
- 心跳：每 30s `ws.ping()` 探活（`HEARTBEAT_INTERVAL_MS`）；`input`/`resize` 对不存在/已断会话静默忽略。
- **回放历史不走 attach 帧**：终端窗格挂载时由客户端经控制面 `sessions.read` 拉缓冲尾部（`client/TermView.tsx` 的 `loadHistory`）。

#### B10 FileService（`src/file-service.ts`，契约 `src/types/file-service.ts`）——本地部分【S1】

- **树根模型**：所有本地读写限定在「当前树根」内。树根由前端每次调用传入（`LocalPathRef.root`），默认值来自 Config `workspaceRoot`（缺省 = DSH 进程 cwd），用户在 UI「换目录」后前端记住新根（localStorage，UI 偏好）。切换根 = 用户主动授权该目录。
- **路径安全（`src/path-security.ts`，纯函数 + 一次 `realpath`）**：`resolveInsideRoot(root, path)` → 先 `path.resolve` 归一化，再对存在的最深祖先做 `fs.realpath` 解析符号链接，最后校验结果以 `realpath(root) + sep` 开头；不满足抛 `PATH_OUTSIDE_ROOT`。空路径 / 含 `\0` 抛 `VALIDATION`。Windows 大小写不敏感比较（`toLowerCase` 后比）。
- **四件套**：
  - `listLocal(ref)`：`readdir(withFileTypes)` 一层，目录在前、按名排序，返回 `FileEntry[]`（symlink 标 `symlink`，不跟随）。
  - `readLocal(ref, { maxBytes = 10MiB })`：先 `stat`，超上限只读前 `maxBytes` 并 `truncated: true`（编辑器按只读打开）；按 UTF-8 解码。
  - `writeLocal(ref, content)`：原子写——写到同目录 `.<name>.tm-tmp-<random>` 再 `rename`；失败清理临时文件。不创建父目录（越权风险），父目录不存在抛 `NOT_FOUND`。
  - `listDirectories(absPath)`：只返回子目录，用于「换目录」选择器；不受树根限制（只读、只列目录名）。
- **错误**：`FileServiceError { code: FileErrorCode }`；系统错误映射：`ENOENT → NOT_FOUND`，`EACCES/EPERM → VALIDATION`（消息不含绝对路径之外的信息），其余 `REMOTE_IO`（本地也复用此码，含义为 I/O 失败）。
- **控制面端点（挂在 B7a `dispatch`）**：`files.tree { root, path }` / `files.read { root, path, maxBytes? }` / `files.write { root, path, content }` / `files.dirs { path }`，返回值与四件套一致；`files.root` 返回配置树根；`files.open { root, path }` 用系统默认程序打开树根内的**文件**（`src/open-external.ts`：Windows `cmd /c start ""`、macOS `open`、Linux `xdg-open`；不在 FileService 契约内，是主线自己的功能）。
- **打开规则（前端 `client/files/openRule.ts`）**：文本类扩展名（txt / md / sh / py / json / ini / csv / log / yaml / xml / conf / toml / bat / ps1 …）双击进编辑器；其余（xlsx / docx / pdf / 图片 / 压缩包 …）双击交给系统程序；右键菜单两项都有。
- **远端部分**（`listRemote` / `upload` / `download` / `downloadToLocal`）S5 实现；S1 里这四个方法抛 `UNSUPPORTED`。
- **事件**：本地读写不派发 `file` 事件（S5 远端传输才派发）。

#### B11 TC 脚本解析（`src/tc-parser.ts`，纯函数）【S3，语法按 2026-09-02 真实样例】

真实脚本不是逐行前缀，而是**块状态切换**：一行 `##>数字串` 把「当前目标窗口」切过去，后续命令都发到这些窗口，直到下一个 `##>`。窗口编号 0–9 对应 TC0–TC9（= 活跃会话窗口顺序，D1）。

| 行首形式 | 类型 | 处理 |
|---|---|---|
| `##>012`（`##>` 后仅数字，可带空白） | `target` | 当前目标 = 去重后的各个数字；不发送 |
| `[标题]` / `[!标题]` | `section` | 大标题，不发送，**不重置目标**；记录名字与行号供「执行本节」 |
| `###内容` | `command` | 「可发送的注释」：整行原样发送 |
| `##内容`（非 `##>`） | `comment` | 不发送。含「间隔 N 秒」类人读提示 |
| `#内容`（单个 `#`） | `subtitle` | 小标题，不发送（真实 shell 注释也会被归入此类，反正不发送） |
| 空白行 | `blank` | 跳过 |
| 其他 | `command` | 右侧去空白后发送到当前目标；文件开头未切换过时默认目标 `[0]` |

- **输出**：`parseTcScript(text): TcLine[]`，每项 `{ lineNo, kind, raw, targets: number[], command?: string, section?: string }`；`targets` 是该行生效的目标（对非命令行也带，便于 UI 显示）。
- **选区执行**：`resolveTargetsAt(lines, lineNo)` 返回某行之前最后一次 `##>` 的目标（无则 `[0]`），供「执行选中脚本」在选区不含 `##>` 时继承上文目标。
- **本节范围**：`sectionRange(lines, lineNo)` 返回所在 `[标题]` 到下一个 `[标题]` 前一行的范围，供「执行本节」。
- **执行模型**：前端把 `TcLine` 翻译成 `{ sessionId, command }` 序列（TC 编号 → sessionId 查 `sortedSessions`，执行期间冻结快照），逐条调用控制面 `sessions.send { sessionId, command, source: 'script', wait? }`（= 一次 `sendAndWait`），上一条完成或超时再发下一条；后端不知道 TC 概念。超时项可「跳过」或「中止」。
- **暂定决策（待与同事确认，默认按此实现）**：① 选区不含 `##>` 时继承上文目标并在确认框显示；② `##间隔…` 只当注释，确认框列出提醒，不自动等待；③ `##>01` 后紧跟空行 = 纯切换，不报错；④ 多行 shell 函数体逐行发送，靠静默判定兜底，汇总条如实显示 `quiet`；⑤ 提供右键「执行本节」；⑥ `#` 真实注释被当小标题，接受。
- **不做**：坐标模式、`[!…]` 的显示差异（解析层一律当标题）。

#### 前端模块（`client/`，F1–F6）

**F1 入口与外壳 + 样式（`index.tsx` / `styles.ts`）**：`ctx.slots.inject('sidebar.footer.action', …)` 注册「终端管理」按钮（点击 `toggleWorkspace`）；`ctx.slots.inject('shell.overlay', …)` 挂 `TerminalWorkspace`。样式：`ensureStyles()` 在 `document.head` 追加一条 `<style data-plugin="term-manager">`，xterm.css 走虚拟模块 `tm:xterm-css`（**不用 `?raw`/`?inline`**，tsdown 会留成 external → "missed the module table"）。`WORKSPACE_CSS` 全部为全局 `.tm-` 前缀类名（防污染 DSH），取 `--dsw-*` token（如 `--dsw-alias-bg-base`），无 CSS Modules。

**F2 连接面板（`ConnectionsPanel.tsx`，tm-side）**：右侧并排 300px（`@media (max-width:1000px)` 下 240px）。内容：
- 「连接参数」表单：名称/主机/端口/用户名 + 密码（👁 可见切换）或私钥（+口令）；SSH/Telnet 协议页签（表单内切换，**不是工作区双页签**）；备注；「连接选项」折叠区 = SSH 握手超时（15/30/60/120/180 秒）、换行（LF/CR/CRLF）、本地回显开关；保存/连接/取消按钮；字段带中文悬停提示。
- 折叠区：「活跃会话」（状态点 + 协议徽标 + 名称/目标 + 未读蓝点；点击切换显示/隐藏，隐藏条目变暗+虚线边框；⣿ 手柄拖动排序；右键菜单：置顶/重命名/断开）、「⭐ 收藏」（localStorage 持久化，保存连接自动入收藏）、「最近连接」（右键：收藏/编辑/删除）。
- 经 `rpc.ts`（`client/rpc.ts`，POST `/term-manager/<方法>`）读写；连接动作走 `onConnect` 上抛，由工作区统一发起。

**F3 终端页/工作区 + 广播栏（`TerminalWorkspace.tsx`，tm-main）**：
- 头部：🖥️ 终端标题 + 在线计数（在线 N / 总数）+ 全部隐藏/全部显示/✕ 关闭按钮。
- 终端网格：`.tm-grid`，`grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr))`——单窗格填满模块、多窗格自动换行无空隙；隐藏窗格 `display: none`（不断开会话）。
- 窗格渲染：每个 open 会话渲染一个 `<TermView>`（详见 F4）。
- 广播栏：**两行**——第一行目标 chips（「全部」+ 每个可见会话一个 chip，点选；按钮显示选中数），第二行输入框 + 发送按钮。广播实现 = 对每个目标会话 `ws.input(命令 + '\r')`（并行直写、互不等待；逐台独立，不聚合）。发送后清空输入框。
- WS 生命周期：初始化仅一次；不可见时关 WS；卸载时 `dispose`；首次可见时经控制面拉一次会话全量快照兜底。

**F4 终端组件（`TermView.tsx`）**：单窗格 = 标题条（状态点 + 名称 + 目标 + ✕断开）+ xterm（`@xterm/xterm` + `@xterm/addon-fit`，scrollback 5000，配色低饱和、随 DSH 明暗主题 `data-ds-dark-theme` 动态切换）。键盘经 `ws.onData → ws.input` 直达设备；Ctrl+C（有选区→复制/无选区→透传 SIGINT）+ Ctrl+Shift+C/V + Cmd+C/V + 右键（有选区→复制/无选区→粘贴，PuTTY 式）+ `execCommand` 降级。挂载时 `loadHistory`：经 `sessions.read` 拉缓冲尾部文本回放（`truncated` 时追加「[历史已截断]」）。`ResizeObserver` 触发 `fit.fit()` + `ws.resize`；窗格隐藏时新输出标记未读。

**F5 WS 客户端（`ws.ts`）**：`TermWs` 维持单条 `/term-io` 连接，按 `sessionId` 分发帧；断线指数退避重连（基础 1s、上限 10s）。**设计偏离**：重连后不再由 ws.ts 自动 re-attach 旧会话，而是清空附着列表并通知前端回调 `reconnectHandler()`，由前端重新拉取会话列表并重建终端窗格（`TerminalWorkspace.tsx` 的 `onReconnect`）。最终效果等价——断线后终端自动恢复，后端环形缓冲保留输出历史。

**F6 状态同步 + 布局 + 未读（`store.ts`）**：
- 可见性：模块级 `useSyncExternalStore`；`setWorkspaceVisible` **同步** capture/restore 原始 frame grid（不依赖 React effect 时序）。
- 布局：`useFrameLayout(active, chat)` 把 frame 网格强制为 `${sidebar}px ${有效聊天宽}px 0px`（`MutationObserver`/`ResizeObserver`/窗口 resize 时重算）；`TARGET_TERM_WIDTH = 480`、`PANEL_WIDTH = 300`，未拖动时 `有效聊天宽 = 视口 - 侧栏 - 480 - 300`（聊天自动填满左侧、无留白）；手动拖动后用手动值（下限 300，上限 `max(760, 视口宽-764)`——大屏可把终端收窄至约 200px）。
- 未读：新输出时未读会话条目显示蓝点，点击标记已读。

#### 前端新增模块（F7–F11，九月）【S1–S3】

叠加在现有工作区上，**不改 DSH 骨架、不改连接面板与广播栏**（设计方案 2.1「零迁移」）。交互细节以仓库外的交互设计文档为准，这里只定模块边界与状态归属。

| 模块 | 文件 | 职责 | 状态归属 |
|---|---|---|---|
| F7 本地文件面板 | `client/files/FilePanel.tsx` + `client/files/useLocalFs.ts` | 广播栏下方的收起条 / 展开面板：面包屑、上一级、刷新、换目录（目录选择弹窗，走 `files.dirs`）、列表单击选中 / 双击目录进入 / 双击文件 → 编辑器打开。远端面板 S5 复用同一列表组件 | 树根 + 折叠态 + 当前目录：localStorage（UI 偏好）；选中项：组件内 |
| F8 浮动编辑器窗 | `client/editor/EditorWindow.tsx` + `client/editor/useFloatWindow.ts` | `position: fixed` 窗体，z-index 60–90：标题条拖动、右下角缩放、最大化、最小化成底部标签；每次打开居中偏下默认尺寸（D3 不记忆几何）；内部 TabBar（开 / 关 / 切换 / 脏点 / 关前保存确认） | Tab 列表 + 激活 Tab + 脏标记：`client/editor/editorStore.ts`（内存，不落盘） |
| F9 代码编辑器 | `client/editor/CodeEditor.tsx` | CodeMirror 6 封装：按扩展名装语言包（sh / py / json / md，csv 与其余走纯文本）、Ctrl/Cmd+S 保存（`files.write`）、选区变化回调、只读模式（>10MB）。CSS 走虚拟模块 `tm:codemirror-css`（同 `tm:xterm-css` 机制） | 文档内容在 CodeMirror state 内 |
| F10 TC 执行 | `client/tc/TcConfirmDialog.tsx`、`client/tc/TcSummaryBar.tsx`、`client/tc/runScript.ts` | [▶ 执行脚本] / 右键「执行选中脚本」/「执行本节」→ 解析（B11）→ 冻结映射快照 → 确认框（逐条命令将发往哪些终端、无对应终端标 ✗、「本次会话不再确认」）→ 逐条 `sessions.send`（source `script`）→ 常驻汇总条（逐端口 ✓ / ✗ / waitReason，可关闭）。执行中窗格闪烁（复用现有 focus-flash） | 「不再确认」：sessionStorage；执行进度：`runScript` 内部状态机 |
| F11 发送选中 | `client/tc/SendSelectionDialog.tsx` | [▶ 发送选中→] / 右键「发送选中到终端…」→ 在线终端复选框（默认勾当前激活）、发送(N)、>20 行提示 → 逐条 `sessions.send`（source `script`）→ toast 汇总 | 组件内 |
| TC 徽章 | `client/TermView.tsx` 标题条、`client/ConnectionsPanel.tsx` 活跃会话项 | 在线会话 ≥1 即显示 TC0/TC1…（D4）；编号 = `sortedSessions` 中 open 会话的序号；拖动排序即换编号（D1）；单终端时拖动手柄禁用 | 派生自现有 `sessionOrder`，不新增状态 |

- **按钮可用性矩阵（D5）**：`.txt` 两个按钮都可用；`.md` 只可「发送选中」；其他类型都禁用（tooltip 说明）。
- **编辑器只编辑本地文件**（交互设计 §11.4）；远端文件不进编辑器。
- **样式**：每个模块一个文件 `client/styles/files.ts` / `editor.ts` / `tc.ts`，在 `client/styles/index.ts` 拼接。
- **打包**：CodeMirror 全量打进 `client.js`（设计方案 2.7 方案 B），预计 ~2MB；不做 chunk 基建。

### 核心需求 → 代码路径（走一遍）

**你敲一个键（S4）**：
`F4 键盘事件 → F5 WS（input 帧）→ /term-io → B7b → B4.write → B2/B3 传输 → 设备`
回程：`设备 → onData → B4.handleData（写环形缓冲 + 推订阅者）→ /term-io → F5 → F4 渲染`

**AI 发命令（S7）**：
`AI → B6 tm_send → B4.sendAndWait（过 B8 守卫 + 独占）→ B2/B3 写入 → 输出流喂 B5 完成判定 → 判定完成 → 整段输出返回 AI`。同一份输出同时经订阅推给前端——所以你能实时看见 AI 在干什么（S10）。

**广播（S5/S6）——服务端（tm_send_all）**：`B4.broadcast(命令, 目标列表)` 对每个目标独立触发一次「写入 + 判定」，`Promise.all` 并行、互不阻塞。每台结果必为以下之一：

| 结果 | 含义 | 处理 |
|---|---|---|
| `ok` | 正常执行完 | 返回该台输出 + waitReason |
| `busy` | 该台正在跑别的命令（独占发送中） | 跳过并标记 `busy`，不影响其他台 |
| `disconnected` | 会话不存在或已断开 | 标记 `DISCONNECTED` |
| `error` | 其他异常（含 COMMAND_BLOCKED/PROTO_ERROR） | 返回 `code` |

**广播（S5/S6）——客户端广播栏**：`F3` 对选中的会话逐个 `ws.input(命令 + '\r')` 直写，并行且互不等待，不做完成判定。

### 关键参数默认值（B5 及连接级配置）

| 参数 | 默认值 | 可调范围 | 在哪调 |
|---|---|---|---|
| 静默期 `quietMs` | 500ms | 100–5000ms | 连接配置 / tm_send 参数 |
| 提示符正则 `promptPattern` | 不启用 | 任意合法正则 | 连接配置 |
| 超时兜底 `timeoutMs` | 30s | 1–300s，每次调用可覆盖 | 连接配置 / tm_send 参数 |
| 判定顺序 | 提示符 > 静默 > 超时；无输出时只有超时生效 | — | — |
| 单次返回输出上限 | 256 KB（超出截断并标记 truncated） | — | WAIT_LIMITS.outputCapBytes |
| 输出环形缓冲 | 每会话 1 MiB | — | BUFFER_CAP_BYTES |
| 连接建立超时 | 15s（SSH `readyTimeout`；Telnet 同用 `connectTimeoutMs`） | SSH UI：15/30/60/120/180s | `handshakeTimeoutSec` / `connectTimeoutMs` |
| 换行 `newline` | `crlf` | `lf / cr / crlf` | 连接配置 + sendAndWait 调用参数 |
| 本地回显 `localEcho` | false | 开/关 | 连接配置（后端已保存；xterm 本地回显未接通，见「待确认项」） |
| 本地工作区根 `workspaceRoot` | DSH 进程 cwd | 任意目录 | 插件 Config schema（`cordis.yml` 的 `config:`）；UI「换目录」临时切换 |
| 编辑器打开上限 | 10 MiB（超出只读 + 截断） | — | `files.read` 的 `maxBytes` |
| Telnet 文件传输开关 `telnetFileTransfer` | true | 开/关 | 插件 Config schema【S5】 |

### 订阅与会话的生命周期（谁看、谁连、谁清理）

「看」和「连」是两回事：订阅 = 看（前端窗口附着在会话输出上）；会话 = 连（设备连接本身）。关掉页面只是不看了，连接保持——随时回来接着看，AI 也可能还在用。

清理规则：
1. **页面关闭 / 面板收起** → 浏览器与后端的字符管道（WS）断开 → 后端把挂在这条管道上的所有订阅**随管道一起清掉**。管道是订阅的唯一载体。
2. **管道假死**（断网等无通知场景）→ 后端每 30s 发心跳（`ws.ping`），`onclose` 触发后同样清理；浏览器侧 `TermWs` 指数退避自动重连，重连后前端重建终端状态。
3. **AI 调用结束 ≠ 停流**：AI 的一次 `tm_send` 是「一问一答」的短等待器，条件满足即自动注销；设备输出流属于会话本身，持续存在，谁要看谁订阅。
4. **零订阅的会话继续活着**（有意设计）；会话的终结只有三种：显式断开、设备掉线、插件卸载（`ctx.effect` 清理全部连接与管道）。
5. **会话列表状态传播**：状态变化（connecting/open/closed）时 `notify` → `/term-io` 推 `status` 帧 → 客户端更新列表/徽标。前端只保留 `open` 会话条目（`connecting` 跳过避免连接失败时幽灵条目，`closed` 移除）。

### 错误码约定

所有错误（控制面 RPC 响应、数据面 `status` 帧、AI 工具返回）统一格式 `{ code, message }`；`message` 供人阅读，**永远不含密码/密钥内容**。核心错误码：

| code | 含义 |
|---|---|
| `VALIDATION` | 表单/参数校验失败 |
| `AUTH_FAILED` | 用户名、密码或密钥不对 |
| `HOST_UNREACHABLE` | 地址不通 / 域名解析失败 |
| `CONN_TIMEOUT` | 连接超时（15s 起，可配） |
| `SESSION_NOT_FOUND` | 会话/连接不存在或已结束 |
| `SESSION_BUSY` | 该会话正在执行另一条发送（独占中） |
| `DISCONNECTED` | 会话已断开（设备掉线或手动断开） |
| `COMMAND_BLOCKED` | 命令命中黑名单（命令守卫拦截） |
| `PROTO_ERROR` | 协议层错误（SSH 通道建立失败等） |
| `PATH_OUTSIDE_ROOT` | 文件路径落在当前树根之外（含符号链接逃逸）【B10】 |
| `NOT_FOUND` | 文件 / 目录不存在【B10】 |
| `FILE_TOO_LARGE` | 超过读取 / 传输上限【B10】 |
| `REMOTE_IO` | 文件 I/O 失败（本地或 SFTP）【B10】 |
| `UNSUPPORTED` | 该会话协议 / 当前阶段不支持此文件操作【B10】 |

### 命令安全防护（AI 发危险命令怎么办）

**第一道防线（DSH 自带，用户配置）**：DSH 工具执行策略可对六个 `tm_*` 设置「允许/禁止/每次先问我」——部署配置，不改插件代码。
**第二道防线（插件内建 B8 命令守卫）**：内容级检查——只检查 AI 发起的发送（`tm_send`/`tm_send_all`），人的键盘输入不拦；黑名单命中即拦截并返回 `COMMAND_BLOCKED`（AI 会看到拒绝原因并告知）；按连接 `guardWhitelist` 可豁免（同一命令在某台设备上可能是正常操作）；广播逐台检查、互不阻塞；所有拦截写日志。MVP 不重复造「确认弹窗」——「要确认后再放行」交给第一道防线。
**优先级规则**：键盘输入永远实时、不排队；命令发送每会话独占——已有在跑时新发送直接返回 `SESSION_BUSY`；广播逐台并行、互不阻塞。

### 模块间契约（`src/types/`）与扩展模块【2026-09-02 冻结】

九月起两人并行：主线（终端 / 编辑器 / 文件面板 / TC 执行 / 文件传输，主线负责人）与扩展模块（日志管理 / 共享端口，扩展模块负责人）在不同分支开发，靠下面三个**纯声明**文件解耦：

| 契约文件 | 内容 | 谁实现 | 谁消费 |
|---|---|---|---|
| `src/types/events.ts` | `TmEvent`（output / input / status / file）+ `TmEventBus`（emit / on + 过滤） | B4 埋点 + B9 总线（主线） | 日志管理（落盘）、共享端口（旁观） |
| `src/types/session-api.ts` | `SessionManagerApi` 公开面 + 会话数据类型 | B4（主线） | 共享端口（控制会话只走这些方法，不绕过） |
| `src/types/file-service.ts` | `FileService`（本地 listLocal/readLocal/writeLocal/listDirectories；远端 listRemote/upload/download/downloadToLocal）+ 错误码 + 进度类型 | 主线（M1 本地，M5 远端） | 日志管理（日志落盘 / 下载复用同一入口） |

**规则**：
1. 契约目录只放声明，不放实现；**任何改动单独提 PR 到 main，两人 review**，功能分支不碰。
2. 扩展模块只 import `src/types/`，不 import 主线实现文件；主线不知道扩展模块内部。
3. 挂载点：host 半 `src/ext/index.ts` 的 `registerExtensions(ctx, { sessions, events, files?, dataDir })`；浏览器半 `client/ext/index.tsx` 的 `registerClientExtensions(ctx)`；样式 `client/styles/index.ts` 的 `EXT_CSS`。主线在这三处各留一行调用，扩展模块的代码放 `src/ext/<模块>/`、`client/ext/<模块>/`、`client/styles/<模块>.ts`、`tests/ext-<模块>.spec.ts`。
4. `dataDir`（`~/.dsh/terminal-manager`）下扩展模块开自己的子目录落盘，不写 `connections.json`。

#### 扩展模块：日志管理 / 共享端口（扩展模块负责人）——待补充

> 需求文档尚未成稿。本节由扩展模块负责人按上面的规则补写：模块职责、订阅哪些事件、落盘格式、对外路由 / UI 入口、测试点。主线不代写。

### 可扩展性设计（为后续功能留的口子）

| 未来功能 | 落点（现在的接缝） | 说明 |
|---|---|---|
| **串口** | 新增 `SerialTransport` 实现 `src/transport/types.ts` 的同一传输接口 + 表单加协议选项 | **交付后第一个扩展项**（用户拍板）；传输接口与协议无关 |
| **SSH 跳板机/堡垒机** | B2 经 ssh2 的 `sock` 选项串接目标连接；表单加「跳板机」字段 | 用户暂不确定，MVP 不做；卡住联调再启动 |
| **共享会话/端口** | B4 已是公共会话池，天然多方访问；只需加「参与者列表 + 输入权限」 | 这是当初不用 DSH 私有终端模型的原因之一 |
| **SSH 端口转发** | B2 加转发通道；B6 加对应工具 | 传输层接口化，不加能力不动上层 |
| **命令审计/回放** | B4 环形缓冲升级为落盘事件流 | 输出本来就集中经过会话管理器 |
| **定时巡检** | 新增调度模块，复用 B6 同一批工具 | 工具层即能力层 |
| **凭据加密** | 接 DSH `ctx.credentials` 服务，替掉明文 JSON | 后续迭代 |
| **SSH 主机密钥 TOFU** | 首次信任 + 指纹核对 | MVP 后首个安全迭代 |

原则：**新增协议 = 加一个传输实现；新增能力 = 加一个工具 + 接缝模块；核心池（会话管理器）保持稳定**。

## 仓库结构

```
dsh-terminal-manager/
├── package.json               # dsh.bundle（cordis.patch.yml）+ dsh.client 双 manifest
├── cordis.patch.yml           # host 半插件插入行
├── tsdown.config.ts           # lib/index.js（host 半）+ lib/client.js（浏览器半工厂包）
├── vitest.config.ts           # src-only 覆盖率阈值 72/72/60/74（语句/函数/分支/行）
├── src/                       # host 半（B1–B8）
│   ├── index.ts               # 插件入口：装配 ConnectionStore + SessionManager + 工具 + 两个路由
│   ├── connection-store.ts    # B1 连接存储
│   ├── session-manager.ts     # B4 会话管理器（心脏）
│   ├── wait-policy.ts         # B5 完成判定
│   ├── command-guard.ts       # B8 命令守卫
│   ├── transport/
│   │   ├── types.ts           # 传输接口 + TransportError
│   │   ├── ssh.ts             # B2 SSH 传输
│   │   └── telnet.ts          # B3 Telnet 传输（telnet/raw 双模式）
│   ├── tools.ts               # B6 AI 工具 ×6
│   ├── remotes.ts             # B7a 指令通道（/term-manager 前缀路由）
│   ├── ws-io.ts               # B7b 数据流通道（/term-io WS）
│   ├── event-bus.ts           # B9 事件总线实现
│   ├── file-service.ts        # B10 文件服务（S1 本地四件套；S5 远端）
│   ├── path-security.ts       # B10 路径安全（归一化 + realpath + 树根校验）
│   ├── tc-parser.ts           # B11 TC 脚本解析（纯函数）
│   ├── config.ts              # 插件 Config schema（workspaceRoot / telnetFileTransfer）
│   ├── types/                 # 模块间契约（纯声明；改动单独 PR，两人 review）
│   │   ├── events.ts          #   TmEvent / TmEventBus
│   │   ├── session-api.ts     #   SessionManagerApi + 会话数据类型
│   │   └── file-service.ts    #   FileService（本地 + 远端）
│   └── ext/                   # 扩展模块（扩展模块负责人）：index.ts 是唯一挂载点，模块放 ext/<模块>/
├── client/                    # 浏览器半（F1–F6）
│   ├── index.tsx              # 入口：slots（sidebar.footer.action + shell.overlay）+ 样式注入 + 扩展挂载
│   ├── TerminalWorkspace.tsx  # F1/F3 覆盖层外壳 + 终端网格 + 广播栏
│   ├── ConnectionsPanel.tsx   # F2 连接面板（表单 + 收藏 + 最近连接 + 活跃会话）
│   ├── TermView.tsx           # F4 xterm.js 窗格
│   ├── ws.ts                  # F5 /term-io WS 客户端（重连 + attach）
│   ├── rpc.ts                 # /term-manager RPC 客户端
│   ├── store.ts               # F6 状态同步（可见性/布局/未读）
│   ├── files/                 # F7 本地文件面板（FilePanel.tsx + useLocalFs.ts）
│   ├── editor/                # F8/F9 浮动编辑器窗 + Tab + CodeMirror（EditorWindow / CodeEditor / editorStore）
│   ├── tc/                    # F10/F11 TC 执行（确认框 / 汇总条 / runScript）+ 发送选中弹窗
│   ├── styles/                # 全局 .tm- 前缀 CSS（--dsw-* token），按功能分文件，index.ts 拼接
│   ├── ext/                   # 扩展模块浏览器半（扩展模块负责人）：index.tsx 是唯一挂载点
│   └── raw.d.ts               # 声明虚拟模块（tm:xterm-css）
├── scripts/
│   ├── mock-device.mjs        # 模拟 Telnet 设备（路由器 CLI，ANSI 色，退格钳制）
│   ├── mock-ssh-device.mjs    # 模拟 SSH 设备（admin/test-pass，吃任意密钥）
│   └── smoke-e2e.mjs          # 19 场景冒烟（对活服务）
├── tests/                     # 282 项 vitest（26 个 spec 文件）+ helpers.ts（模拟设备工厂）
├── evals/                     # scenarios.md（24 条 eval 种子）+ manual-acceptance.md（人工验收清单）
├── （docs/ 不入库）             # 设计方案 / 交互设计 / 归档文档放仓库外 ../开发过程文档/
├── prototypes/                # M1 交互原型 + SELECTION.zh.md 选型结论；九月原型 design-demo / file-panels / float-editor-*
├── intent/intent.md           # 已 Accepted
├── spec.md                    # 本文件（唯一设计源）
└── plan.md                    # 构建计划（已批准）
```

## 应用的标准

- **DSH 插件规范**：`apply(ctx)` + `inject` 声明、effect 自动清理、配置经 Config schema（参照 `docs/user/develop/basic/*`）。
- **工具作者规范**：`docs/cookbook/adding-a-tool.md`——参数自动校验、规范 JSON 输出、遵守 `exec.signal`、纯函数 `presentCall/presentResult`、工具不导入 UI 类型。
- **信任栅栏**：数据面 `/term-io` 复用 `isLoopback` 模式（MVP 仅 loopback）；控制面 `/term-manager` 依赖本机绑定限域。
- **评审标准**：本仓库 `REVIEW.md`。

## 陷阱与风险

1. **【已定案】外部包的浏览器半装配**：M0 已打通（双半包按 `tsdown` 的 `deps.neverBundle/alwaysBundle` 打包，`@deepseek-ai/*` 走 `link:` 基线，产物 `lib/index.js` + `lib/client.js`）。残留风险：外部分依赖（xterm、ssh2、ws）版本须锁在 `package.json`/lockfile，与宿主共存。
2. **DSH 开发者预览破坏性变更**：集成面已最小化（不依赖 `ctx.terminals`/`tool-terminal`/`ctx.typert.remotes`，只用 `ctx.webServer.register/registerUpgrade`、`ctx.tools`、`ctx.slots`）；`@deepseek-ai/*` peer 用 `link:` 指向相邻检出（版本严格一致）。
3. **`ctx.effect` 陷阱**：`ctx.effect(fn)` 的 fn 是 setup、返回的是清理函数——把 `webServer.register(...)` 的 disposer 直接当 fn 传会立即执行清理、删掉刚注册的路由（请求 405）。两个注册函数均已按 `ctx.effect(() => webServer.register(route))` 正确实现（`remotes.ts`、`ws-io.ts`）。
4. **`connection.rpc.handle` 作用域问题 + `/api` 与 api-gateway 冲突**：这是控制面选独立前缀路由 `/term-manager` 的原因；`client/rpc.ts` 与 `scripts/smoke-e2e.mjs` 都 POST 到 `/term-manager/<方法>`，而非 `/api`。
5. **OPTIONS 预检**：浏览器 POST `application/json` 会先发 OPTIONS——自建路由必须处理（`createHttpHandler` 返回 204 + CORS 头），否则预检 405 卡住。
6. **第三方 CSS 内联**：xterm.css 用虚拟模块 `tm:xterm-css` 内联（tsdown 不认 `?raw`/`?inline`，会留成 external → "missed the module table"）。
7. **ssh2 测试服务器**：写测试/模拟 SSH 服务器必须处理 `session.on('pty', accept)`，否则客户端 `shell()` 报 "Unable to request a pseudo-terminal"。
8. **明文凭据**：已接受；`connections.json` 权限 0600（Windows 尽力）；错误消息/日志/工具返回永不含凭据。
9. **SSH 主机密钥不校验**：MVP 显式接受（`hostVerifier: () => true`）；TOFU 列为首个后续安全迭代。
10. **完成判定误判**：静默期对持续输出命令（如 `tail -f`）会一直等到超时——这是预期行为，提示词指引 Agent 对长命令用 `immediate` + `tm_read`；`promptPattern` 可按设备调优；无输出时只认超时。
11. **Telnet 双字符回显/协商差异**：`telnetMode` 双模式缓解——`telnet` 模式剥离 IAC 协商字节（只剥不回发，避免 echo server 回环）；某些设备回显行为不一致（本地回显/远端回显），`localEcho` 开关已保存后端（xterm 本地回显未接通，见「待确认项」）。
12. **广播**：客户端广播栏对每台 WS 直写（不聚合、不等待）；`tm_send_all` 逐台 `sendAndWait` 聚合；某台 `busy`/`disconnected`/`error` 不阻塞其余台。
13. **布局依赖 DSH frame DOM 结构**：`useFrameLayout` 直接写 frame 的 `gridTemplateColumns`（capture/restore 同步于 `setWorkspaceVisible`）；DSH 若改 frame 结构/类名可能失效——兜底是换回侧边栏入口 + 覆盖层的通用形态，验证项已覆盖。

## 待确认项

| 项 | 状态 |
|---|---|
| 跳板机/堡垒机 | 用户暂不确定；MVP 不做，接缝已留（B2 `sock` 串接 + 表单字段） |
| 灵枢平台 MaaS 绑定 | 1.1 第 3 条「初版 MaaS 服务绑定灵枢平台，API 简化配置」用户挂起，不阻塞 |
| AgentTerm 参考 | 用户后续口头描述其 SSH/Telnet 连接设计（使用习惯）；影响连接表单与交互细节，开工前再问一次 |
| 设备提示符形态 | 联调时观察收集；已定策略：预置常见网络设备提示符模板按连接选用，不启用时静默期判定兜底 |
| 本地回显在 xterm 接通 | `localEcho` 已保存后端；xterm onData 本地回显未接通（需 term.write + 控制字符处理，中等复杂度，推迟） |
| 凭据加密（DSH `ctx.credentials`） | 后续迭代，替掉明文 JSON |
| SSH 主机密钥 TOFU | MVP 后首个安全迭代 |
| 面板入口快捷键 | 延后，MVP 不做 |
| TC 脚本 6 项暂定决策（B11） | 按暂定值实现；与同事确认后若有变只改 `tc-parser.ts` / `runScript.ts` |
| Excel（.xlsx）等非文本文件 | **已定（2026-09-02）：不自己编辑，交给用户本机的默认程序打开**——`files.open` 端点（B10）在树根围栏内用系统关联程序打开；面板双击非文本文件即走此路 |
| better-sidebar 源码位置 | 已拿到：`../DSH-better-sidebar`（MIT，v0.18.0-alpha.0）。抄 path-security / fs-tree / FreeWindow / TabBar / TextEditor+cm-themes，逐文件裁剪，对照表见 plan.md |
| 日志模块的本地落盘 / 下载入口 | `writeLocal` 限树根、`download` 是远端下载，日志模块可能需要不限树根的写和本地下载路由——待同事确认后按需追加契约方法 |

## 验证计划

**构建期测试（`pnpm test` = vitest，282 项基线）**
- 九月新增：`config`（schema 缺省 / 覆盖）、`path-security`（逃逸 / junction / win32 大小写）、`file-service`（本地四件套 / 原子写 / 截断）、`remotes-files`（files.* 与 sessions.send 端点）、`tc-parser`（真实样例整段）、`client-files` / `client-editor-store` / `client-lang` / `client-tc`（前端纯逻辑：面板状态、Tab 状态机、语言映射与几何、执行计划 / 串并行 / 超时 / 中止）。
- 单元：`wait-policy` 三重判定的时序用例（优先级/无输出只有超时/截断）；`connection-store` 持久化/校验/落盘；`command-guard` 黑白名单；`session-manager` 状态机、独占发送、去重、广播逐台结果。
- 传输：进程内 ssh2 Server + 本地 TCP echo 服务，跑真实 `connect → send → 完成判定 → read → disconnect` 全链路；断连、超时、忙碌并发路径（`tests/transport.spec.ts` 等）。
- 工具层：经测试上下文调用六个 `tm_*`，断言 schema 与返回（含 `presentCall` 卡片）。
- 集成胶水：`remotes`（HTTP handler / dispatch）、`ws-io`（帧分发/心跳/订阅清理）、`client/` 的 `ws`（重连/attach）、`rpc`（封包解包）、`store`（布局/可见性）——`tests/` 目录 14 个 spec 文件。
- 覆盖率阈值（src-only，`vitest.config.ts`）：语句 72 / 分支 60 / 函数 72 / 行 74。

**模拟设备**
- `scripts/mock-device.mjs`：Telnet 路由器 CLI（ANSI 色：提示符绿/横幅青/错误红）；退格钳制（输入行空时不回退，防删掉 `router>` 提示符）；`--iac` 旗标可发 IAC 协商序列。
- `scripts/mock-ssh-device.mjs`：SSH 路由器 CLI（用户名 admin + 密码 `test-pass`，任意密钥都接受；处理 `pty`）。
- 冒烟：`scripts/smoke-e2e.mjs` 19 场景，对活服务（`DSH_PORT` + 2323/2324 Telnet + 2222 SSH）：临时连接、保存连接/connId 连、编辑/删除、校验、横幅、多设备、断开后操作报错、SSH 密码连接/错密码→`AUTH_FAILED`/地址不通等。

**验收演示（对照 intent 的「期望结果」）**
1. 新建两条连接配置 → 点击连接 → 两个终端出现并实时输出；
2. 广播一条命令 → 两个终端同时回显；
3. 让 DSH Agent 执行「连接 A，跑 `<命令>`，告诉我结果」→ Agent 调 `tm_connect`/`tm_send` 并汇报输出。

**Eval 套件（Test 阶段）**
- `evals/scenarios.md` 24 条种子（E1–E24）：配置管理、连接与观察、手动操作、AI 自动化、异常、WS 断线重连；每条约 1 条机器可检查的通过条件。CI 自动化是后续项（需 agent runner + API 预算）。
- `evals/manual-acceptance.md` 人工验收清单（UI 交互：隐藏/显示、拖动、复制粘贴、退格等）。

**运行验证（本地）**
`pnpm build`（tsdown）→ `pnpm test`（282 项全绿）→ 在 `../deepseek-harness` 下 `pnpm dsh --profile tm-dev --port 3180 --no-open`（**3180**；3080 被用户自己的 DSH 占用，别动）。健康判据：`/plugins/dsh-terminal-manager/client.js` 返回 200；首页 `__DSH_BOOT__` 含 `dsh-terminal-manager` 行。