# DSH Terminal Manager — 端口映射、会话共享与日志增量规格

- 派生自：intent/port-mapping-sharing-log.md（Accepted，commit dc1eb4a）
- 参考输入：ipop-port-mapping-sharing-log-design.md
- 作者：Codex；待产品负责人和技术负责人评审
- 状态：Draft
- 日期：2026-09-02
- 设计边界：本文件是本次增量的设计源；原 spec.md 继续描述已经交付的终端管理能力，不被覆盖。

## 1. 需求

### 1.1 功能性需求

#### PM — TCP/UDP 端口映射

| ID | 要求 | 验收结果 |
|---|---|---|
| PM-01 | 用户可创建、查看、编辑、删除端口映射 | 配置包含协议、监听地址/端口、目标地址/端口、自动启动；重启插件后仍存在 |
| PM-02 | 每条映射可独立启动和停止 | 状态明确显示 stopped、starting、running、stopping、error；重复启动/停止是幂等操作 |
| PM-03 | TCP 映射透明双向转发字节流 | 多个并发客户端互不串流；一条目标连接失败不停止监听服务 |
| PM-04 | UDP 映射按来源端点建立独立转发会话 | 数据报边界保留；不同客户端的响应不会串包；零长度数据报合法 |
| PM-05 | 支持 IPv4 和 IPv6 | 监听地址与目标解析使用正确地址族，不进行 sockaddr 式错误拷贝 |
| PM-06 | 支持每条映射自动启动 | 插件加载后启动 autoStart=true 的条目；某条失败不阻断插件和其他条目 |
| PM-07 | UI 展示运行数据 | 展示最近错误、当前活跃 TCP 连接数或 UDP 对端数、客户端到目标和目标到客户端的累计字节 |
| PM-08 | 支持 CSV 导入和导出 | 导入先完整校验再一次性写入；失败时不产生半批数据；导出可由浏览器下载 |
| PM-09 | 映射列表可排序 | 可按协议、监听端点、目标端点、状态排序；排序只影响显示，不改持久化顺序 |
| PM-10 | 运行中配置可以编辑或删除 | 更新采用“停止旧实例 → 保存新配置 → 按原运行状态重启”；删除先确定性停止再移除 |

#### PS — 终端会话共享

| ID | 要求 | 验收结果 |
|---|---|---|
| PS-01 | 任一 open 状态的 SSH/Telnet 会话可启动 TCP 共享 | 默认监听 0.0.0.0；端口由用户指定；同一会话最多一个共享实例 |
| PS-02 | 共享无认证且所有客户端可写 | 客户端连接后立即接收实时设备输出；输入经 SessionManager.write 原样进入当前会话 |
| PS-03 | 支持多个共享客户端 | 客户端分别统计地址、连接时间、收发字节；一个客户端失败不影响其他客户端 |
| PS-04 | 提供基本 Telnet 服务器兼容 | 正确发送 ECHO/SUPPRESS-GO-AHEAD 协商，消费客户端 IAC 协商，不把协商字节写入设备 |
| PS-05 | 慢客户端不能阻塞终端 | 不暂停 SessionManager 输出；客户端待发送缓冲超过 1 MiB 时只断开该客户端 |
| PS-06 | 共享生命周期跟随会话 | 会话 closed/removed、用户停止共享或插件卸载时，监听端口、订阅和客户端全部清理 |
| PS-07 | UI 显示并确认风险 | 启动前明确提示“任何能访问该端口的客户端都能查看并控制终端”，用户确认后才发起启动 |
| PS-08 | 不回放共享前的历史 | 新客户端只收到欢迎消息和连接后的实时输出，避免无意泄露共享开始前的终端内容 |

#### AL — 插件应用日志

| ID | 要求 | 验收结果 |
|---|---|---|
| AL-01 | 支持 debug、info、warn、error 级别 | 每行包含 ISO 时间、级别、事件名和经过清理的结构化字段 |
| AL-02 | 日志按 5 MiB 轮转，最多保留 5 个文件 | 写入前检查大小；轮转后含当前文件在内不超过 5 个 |
| AL-03 | 记录关键生命周期和错误 | 包含插件、映射、共享、会话日志的启动/停止/失败，以及共享客户端连接/断开 |
| AL-04 | 不记录终端内容和认证信息 | 不写设备输出、用户输入、密码、私钥、passphrase、认证载荷或访问令牌 |
| AL-05 | 文件 I/O 失败不能使插件崩溃 | 降级到 console 的简短错误；避免递归调用 logger |

#### SL — 会话输出日志

| ID | 要求 | 验收结果 |
|---|---|---|
| SL-01 | 会话日志默认关闭，可按 open 会话启动和停止 | 每个会话独立控制；重复启动/停止幂等 |
| SL-02 | 只从 SessionManager 的设备输出订阅写日志 | 不直接记录浏览器或共享客户端输入；如果远端设备主动回显输入，该回显仍属于设备输出 |
| SL-03 | 可运行时配置时间戳和 ANSI 清理 | 配置变更只影响后续输出；时间戳按逻辑行添加；ANSI 跨数据块时仍正确处理 |
| SL-04 | 不轮转、不限制保留数量 | 文件持续增长到用户停止日志或会话关闭；UI 必须提示磁盘占用风险 |
| SL-05 | 停止时完整刷盘并关闭句柄 | 会话关闭、移除、插件卸载或用户停止时，剩余半行也被写入，随后关闭流 |
| SL-06 | UI 展示日志状态和完整路径 | 展示开启时间、时间戳/ANSI 设置、已写字节、最近错误，可复制路径 |

#### UI/RPC — 集成

| ID | 要求 | 验收结果 |
|---|---|---|
| UI-01 | 复用 /term-manager 控制面 | 所有创建、修改、启停、导入导出都通过现有 RPC 封包 |
| UI-02 | 扩展 /term-io 下行事件 | 映射、共享和会话日志状态增量推送给浏览器；断线重连后 RPC 全量重取 |
| UI-03 | 接入现有 React 工作区 | 右侧管理区增加“连接 / 端口映射 / 日志”页签；终端标题栏增加共享和日志入口 |
| UI-04 | 不新增 Agent 工具 | 现有六个 tm_* 工具保持不变，Agent 不能自动开放或修改端口 |
| UI-05 | 沿用现有视觉与错误风格 | React 18、全局 .tm- 前缀、client/styles.ts、--dsw-* token、中文提示和 RpcError 处理保持一致 |

### 1.2 非功能性需求

| 类别 | 要求 |
|---|---|
| 兼容性 | TypeScript strict；Node ESM host + React 18 browser 双半包；Windows 必验，Node 支持的平台尽量可用 |
| 性能 | 不使用轮询 busy-loop；TCP 使用 Node 流背压；UDP 使用事件驱动 socket；运行指标推送最多每 500ms 合并一次 |
| 资源上限 | 单个共享慢客户端缓冲上限 1 MiB；单条 UDP 映射最多 1024 个活跃来源端点；每个待建立 UDP 对端最多缓存 64 个数据报或 1 MiB |
| 安全 | 控制面和 /term-io 继续使用当前 loopback 信任栅栏；共享端口按已接受 intent 对外、无认证、可写；日志和错误不得泄露凭据 |
| 数据 | 新文件放在 resolveDataDir() 下；目录尽力设为 0700、文件尽力设为 0600；不改变 connections.json |
| 可靠性 | 所有 start/stop/close 幂等；同一资源的并发操作串行化；单个映射、客户端或日志流失败不拖垮插件 |
| 可观察性 | 状态、最近错误、计数器经 RPC/WS 可见；应用日志可定位生命周期问题 |
| 可维护性 | 不复制 SSH/Telnet transport；共享和会话日志只依赖 SessionManager 公共接口；不增加 C++/Python 实现 |

## 2. 设计

### 2.1 总体架构

新增能力仍在当前 Cordis 插件 host 半内运行：

~~~text
React 工作区
  ├─ /term-manager RPC ───────────────┐
  └─ /term-io 状态事件/终端数据 ──────┤
                                      ▼
src/index.ts 统一装配与清理
  ├─ ConnectionStore ─ SessionManager ─ SSH/Telnet transport（既有）
  │                       ├─ subscribe ─ SessionShareManager ─ TCP 共享客户端
  │                       └─ subscribe ─ SessionLogManager ── 会话日志文件
  ├─ PortMappingStore ─ PortMappingManager
  │                       ├─ TCP forwarder
  │                       └─ UDP peer forwarder
  └─ AppLogger ───────────────────────── 应用轮转日志
~~~

关键边界：

1. PortMappingManager 是独立 Socket 代理，不依赖 SSH 会话，也不是 SSH tunnel。
2. SessionShareManager 不直接拿 transport，只调用 SessionManager.get、subscribe、write、onStatus。
3. SessionLogManager 只订阅 SessionManager 输出，因此不会在输入路径重复写日志。
4. 浏览器只负责 UI、CSV 文件选择/下载和 RPC，不直接访问 Node Socket 或文件系统。
5. 不创建新的 WebSocket 路由；在现有 /term-io 上增加互相兼容的下行帧。

### 2.2 文件与职责

#### 新增 host 文件

| 文件 | 职责 |
|---|---|
| src/app-logger.ts | 分级应用日志、串行写入、5 MiB × 5 轮转、字段清理、关闭刷盘 |
| src/port-mapping-store.ts | 映射配置类型、校验、JSON 持久化、CSV 解析/生成 |
| src/port-mapping-manager.ts | 映射状态机、操作串行化、TCP/UDP 实例、计数和状态订阅 |
| src/session-share-manager.ts | 每会话共享服务器、Telnet 协商、客户端广播/输入、背压和生命周期 |
| src/session-log-manager.ts | 会话日志状态、输出订阅、流式 ANSI/退格/时间戳处理、文件流关闭 |
| src/network-utils.ts | 本机地址枚举、地址/端口校验和 Node 网络错误归一化 |

端口映射的 TCP/UDP 实现先作为 port-mapping-manager.ts 内部类，避免过早拆分；若实现超过约 500 行或测试需要独立注入，再在同一计划修订中拆为 src/port-mapping/ 子模块。

#### 修改 host 文件

| 文件 | 改动 |
|---|---|
| src/index.ts | 构造 logger、mapping store/manager、share manager、session log manager；传给 RPC/WS；按顺序清理 |
| src/remotes.ts | 扩展 RemoteDeps、endpoint 调度、错误码、CSV 请求体限制 |
| src/ws-io.ts | 增加 mapping-status、share-status、session-log-status 下行帧并管理订阅清理 |
| src/session-manager.ts | 不改变输出/输入路径；只在需要时补充更明确的公开状态类型与 closeAll 清理行为 |

#### 新增/修改 browser 文件

| 文件 | 职责 |
|---|---|
| client/ManagerPanel.tsx | 顶层“连接 / 端口映射 / 日志”页签，连接页继续复用 ConnectionsPanel |
| client/PortMappingsPanel.tsx | 映射表单、状态卡片、排序、启停、CSV 导入/导出 |
| client/LogsPanel.tsx | 应用日志状态、目录以及各会话日志状态汇总 |
| client/SessionActionsDialog.tsx | 单会话共享与日志设置、风险确认、路径复制 |
| client/TerminalWorkspace.tsx | 装配 ManagerPanel、运行态缓存和对话框 |
| client/TermView.tsx | 标题栏增加“共享/日志”按钮和状态徽标，不改变 xterm 输入输出 |
| client/ws.ts | 增加三类状态事件 handler，保持未知帧可忽略 |
| client/styles.ts | 所有新增样式使用 .tm- 前缀与现有 DSH token |

### 2.3 端口映射数据模型

~~~typescript
export type MappingProtocol = 'tcp' | 'udp'
export type MappingState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export interface PortMappingConfig {
  id: string
  protocol: MappingProtocol
  localAddr: string
  localPort: number
  redirectAddr: string
  redirectPort: number
  autoStart: boolean
}

export interface MappingError {
  code: string
  message: string
  atMs: number
}

export interface PortMappingSnapshot {
  config: PortMappingConfig
  state: MappingState
  boundAddr?: string
  boundPort?: number
  activeCount: number
  bytesClientToTarget: number
  bytesTargetToClient: number
  lastError?: MappingError
}
~~~

约束：

- protocol 仅接受小写 tcp/udp；CSV 导入时大小写不敏感，入库统一小写。
- localAddr 必须是 IP 字面量；UI 候选来自 os.networkInterfaces()，并始终加入 0.0.0.0 和 ::。
- redirectAddr 可为 IP 或域名，去除首尾空白后长度为 1–253。
- localPort 和 redirectPort 都必须是 1–65535 的整数；不使用 0 号临时端口，因为配置需要可重复启动。
- id 使用 randomUUID()；运行状态和计数不落盘。
- 同协议、同 localAddr、同 localPort 的完全重复配置在保存时拒绝；通配地址与具体地址的冲突以实际 listen/bind 结果为最终依据。
- port-mappings.json 格式带 version: 1 和 mappings 数组，未知顶层字段忽略；条目字段校验失败时停止加载并报告明确错误，不静默运行错误配置。
- 持久化使用同目录临时文件加 rename，避免进程中断留下半个 JSON；Windows 权限设置失败只记 warn。

### 2.4 PortMappingManager 状态机与并发

每个 id 有独立操作队列，保证 start、stop、update、remove 不并发修改同一实例：

~~~text
stopped ── start ──> starting ── listen/bind 成功 ──> running
                         └──── 失败 ────────────────> error
running ── stop ───> stopping ── 资源释放 ─────────> stopped
error ──── start ──> starting
~~~

- start：running 时直接返回当前快照；starting 时等待同一个 Promise；成功时清空 lastError、计数归零。
- stop：stopped 时直接返回；starting/running/error 都进入清理，最终为 stopped。
- update：校验完整新配置；记录原来是否 running；停止旧实例，持久化新配置，再按原状态启动。新监听失败时配置保留、状态为 error，便于用户修改后重试，不回滚到旧监听。
- remove：先停止并等待资源释放，再从 store 删除。
- autoStart：store 加载后对 autoStart=true 的条目 Promise.allSettled；失败逐条记录，不使 apply() 失败。
- stopAll：插件卸载时先阻止新操作，再并行停止全部条目，方法幂等。
- 状态变化立即通知；高频字节计数最多每 500ms 合并通知一次。

### 2.5 TCP 转发

使用 node:net：

1. net.createServer 创建监听器，以 localAddr/localPort listen。是否占用以 listen 的结果为准，不使用“先探测再绑定”的 TOCTOU 方案。
2. 每次 accept 创建一条到 redirectAddr:redirectPort 的 outbound Socket。目标连接建立前 pause inbound，连接超时为 3 秒。
3. 建立成功后双向 pipe。Node stream 自带背压：任一写端拥塞会暂停对应读端。
4. inbound data 累计 bytesClientToTarget；outbound data 累计 bytesTargetToClient。
5. 任一侧 error 时归一化并记录最近错误，销毁该连接对；监听服务器继续运行。
6. 正常 EOF 使用半关闭语义排空已经进入流管道的数据。
7. stop 时先 server.close 停止 accept，再给活跃连接 2 秒排空；超时后 destroy 两侧，确保端口可释放。
8. 所有 socket 都登记在 Set 中，close/error 只执行一次清理，activeCount 不得为负数。

目标为域名时由 net.createConnection 解析并选择 IPv4/IPv6；监听地址的地址族由 Node listen 使用真实地址决定。

### 2.6 UDP 转发

使用 node:dgram，不模拟 TCP 连接：

1. 根据 localAddr 创建 udp4 或 udp6 监听 socket。
2. start 时用 dns.lookup 解析 redirectAddr 并记住地址族；重启映射时重新解析。
3. 来源键为 family + address + port，每个唯一来源创建一个 UDP peer 和独立的目标 socket。
4. 目标 socket connect 到解析后的 redirectAddr:redirectPort，只接收该目标的响应。
5. 本地数据报通过 peer socket 单次 send；目标响应通过监听 socket单次 send 回原来源，永不拼接或拆分数据报。
6. recv 长度为 0 仍照常转发；只有 error 才进入错误处理。
7. 新 peer 建立期间按数据报排队，上限 64 个或 1 MiB；超过上限丢弃新数据报、记录 warn，但不停止映射。
8. peer 60 秒无任何双向数据即回收；单个 sweep 定时器每 10 秒检查一次，禁止为每个数据报建立定时器或 busy-loop。
9. 单条映射达到 1024 个 peer 后拒绝新来源并记录限流错误，现有 peer 继续工作。
10. stop 立即清除 sweep、关闭监听 socket 和全部 peer socket；close 回调只移除对应 peer，不修改错误的实例。

IPv6 覆盖点包括：IPv6 监听、IPv6 目标、来源键格式、回包地址和 UDP socket 类型。IPv4 监听到 IPv6 目标允许通过独立 peer socket 完成；反向亦然。

### 2.7 CSV

导出格式为 UTF-8、CRLF、带表头：

~~~csv
protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart
tcp,0.0.0.0,8080,192.168.1.20,80,false
udp,0.0.0.0,5353,8.8.8.8,53,true
~~~

兼容导入三种形式：

1. 扩展 6 字段：protocol,localAddr,localPort,redirectAddr,redirectPort,autoStart。
2. IPOP 5 字段：无 autoStart，导入后默认 false。
3. IPOP 3 字段：protocol,localAddr:localPort,redirectAddr:redirectPort；IPv6 必须写成 [::1]:8080。

规则：

- 支持有/无表头、空行和首行 UTF-8 BOM；不支持注释行。
- 使用符合双引号转义的最小 RFC 4180 解析器，不用 split(',')。
- 文件最大 1 MiB、最多 1000 条数据；/term-manager 整体请求体上限设为 2 MiB。
- 导入模式固定为 merge，不删除已有条目；与现有监听键冲突或文件内部重复时整批拒绝。
- 全部解析和领域校验通过后才批量生成 UUID 并一次持久化；任何失败都返回行号和字段名，但不回显整行潜在敏感内容。
- 导出不包含运行状态、计数和错误；浏览器用 Blob 下载，不需要 host 写临时 CSV 文件。

### 2.8 会话共享

~~~typescript
export interface ShareConfig {
  sessionId: string
  localAddr: string
  sharePort: number
  maxClients: number
  welcomeMessage: string
}

export interface ShareClientSnapshot {
  id: string
  remoteAddr: string
  connectedAtMs: number
  bytesSent: number
  bytesReceived: number
}

export interface ShareSnapshot {
  sessionId: string
  state: 'starting' | 'running' | 'stopping' | 'error'
  localAddr: string
  sharePort: number
  clients: ShareClientSnapshot[]
  lastError?: MappingError
}
~~~

默认值：

- localAddr：0.0.0.0。
- maxClients：0，表示不限制数量；仍受操作系统资源与每客户端背压上限约束。
- welcomeMessage：Welcome to DSH Terminal Manager share server 后接 CRLF。
- sharePort：UI 初值为 1000 + 当前可见会话的 1 基序号，最终必须由用户确认且范围为 1–65535。

启动流程：

1. 确认 sessionId 存在且状态为 open。
2. 验证地址、端口、maxClients 和 welcomeMessage 长度（最多 512 字符）。
3. 创建 net.Server 并 listen；EADDRINUSE 等错误归一化，失败时不得留下订阅。
4. 监听成功后只创建一个 SessionManager.subscribe，收到设备输出时广播给所有客户端。
5. 订阅 SessionManager.onStatus；会话变为 closed 或 removed 时自动 stop。

客户端流程：

1. 超过 maxClients（非 0）时发送简短拒绝消息并关闭。
2. 设置 noDelay 和 keepAlive，登记客户端，再发送欢迎消息。
3. 发送 IAC WILL ECHO（FF FB 01）与 IAC WILL SUPPRESS-GO-AHEAD（FF FB 03）。IPOP 文档把 FE 误写成 DO ECHO；本实现按 Telnet 标准使用正确命令。
4. 输入经过每客户端的流式 IAC 状态机：消费 WILL/WONT/DO/DONT、SB...SE 和转义 IAC；普通 UTF-8 使用 StringDecoder 处理跨 chunk 字符；CRLF 和 CR-NUL 归一为 CR 后调用 SessionManager.write。
5. NAWS 等协商信息只消费，不调整真实终端大小，因为 xterm 窗口仍是会话尺寸的唯一来源。
6. 输出编码为 UTF-8，并按 Telnet 规则把数据中的 FF 转义为 FF FF。
7. socket.write 返回 false 时不建立第二份无限队列；当 socket.writableLength 超过 1 MiB，记录 warn 并销毁这个慢客户端。

共享客户端等价于人工键盘输入：不经过 AI CommandGuard，也不等待 SessionManager 的 busy 标志。多个客户端和本地用户同时输入时，字符按 Node 事件到达顺序写入，可能相互交错，也可能干扰正在执行的 AI 命令。UI 风险提示必须包含这一点。

共享配置是运行时状态，不持久化、不自动恢复。会话断开后即使随后 reconnect，也不会自动重新开放原共享端口。

### 2.9 应用日志

AppLogger 接口：

~~~typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface AppLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
  status(): AppLogStatus
  close(): Promise<void>
}
~~~

文件位于 resolveDataDir()/log/，名称使用 app_YYYYMMDD_HHMMSS_mmm.log。行格式为：

~~~text
2026-09-02T10:20:30.123Z INFO mapping.started {"mappingId":"...","protocol":"tcp","localAddr":"0.0.0.0","localPort":8080}
~~~

实现规则：

- 默认最低级别 info；代码仍提供 debug 方法供测试或后续配置使用，本增量不新增设置 UI。
- 写任务进入单一 Promise 队列，保证行顺序；单条字段序列化结果最大 16 KiB，超出时截断并标记。
- 写入前读取当前大小；达到 5 MiB 则关闭当前句柄并新建文件，随后按文件名/mtime 删除最旧文件到总数 5。
- 同一毫秒重名时追加单调序号，禁止覆盖已有文件。
- 结构化字段递归清理键名 password、privateKey、passphrase、authorization、token、secret、credential；调用点仍只能传允许字段，不把清理器当作允许记录原始请求的理由。
- Node 错误只记录归一化 code、message 和 syscall；不记录请求 payload、环境变量或堆栈中的潜在认证数据。
- 记录事件：plugin.started/stopping、mapping.*、share.*、share.client.*、sessionLog.*。不记录 terminal.output 或 terminal.input。
- logger 自身失败仅 console.error 一条固定格式消息；不得再次调用 AppLogger。

### 2.10 会话输出日志

~~~typescript
export interface SessionLogOptions {
  addTimestamp: boolean
  stripAnsi: boolean
}

export interface SessionLogSnapshot {
  sessionId: string
  isLogging: boolean
  filePath?: string
  startedAtMs?: number
  addTimestamp: boolean
  stripAnsi: boolean
  bytesWritten: number
  lastError?: MappingError
}
~~~

文件位于 resolveDataDir()/session_logs/，名称为 session_加 sessionId 前 8 位加 UTC 时间戳再加 .log。文件名不使用用户可控 label，避免路径穿越和非法字符。

写入管线：

~~~text
SessionManager.subscribe 的设备输出
  → StringDecoder UTF-8
  → 可选流式 ANSI 状态机
  → 退格处理和 CR/LF 逻辑行归一化
  → 可选行首 [YYYY-MM-DD HH:mm:ss.SSS]
  → WriteStream
~~~

- ANSI 状态机必须跨 chunk 保留 ESC/CSI/OSC 中间状态；不能只对每个 chunk 跑一个正则。
- 退格只删除当前逻辑行已经缓存的最后一个 Unicode 字符；行首退格忽略。
- CRLF 视为一个换行；单独 LF 换行；单独 CR 用于覆盖当前行，保留覆盖后的最终行内容。
- 停止时 flush StringDecoder、ANSI 状态和未结束逻辑行，然后 stream.end 并等待 finish；不用 destroy 丢弃缓冲。
- WriteStream backpressure 使用队列等待 drain；待写数据超过 1 MiB 时自动停止该会话日志并标为 IO_BACKPRESSURE，防止磁盘故障拖垮进程。
- stream error 时取消会话订阅、关闭句柄、保留 lastError 并通知 UI。
- SessionManager 状态变成 closed 或 removed 时停止日志；reconnect 后默认仍为关闭。
- addTimestamp/stripAnsi 更新只影响后续数据。stripAnsi 在一条未完成 ANSI 序列中切换时，先安全丢弃该控制序列，避免把半条转义写入文件。
- bytesWritten 是实际写入文件的 UTF-8 字节数，不是收到的字符串长度。
- 本增量没有轮转、数量清理、内容读取、搜索或删除日志 RPC。

### 2.11 控制面 RPC

继续使用 POST /term-manager/方法名 和当前 ClientRequest/ClientResponse 封包。

| endpoint | payload | value |
|---|---|---|
| mappings.list | {} | PortMappingSnapshot[] |
| mappings.create | 不含 id 的 PortMappingConfig | PortMappingSnapshot |
| mappings.update | { id, patch } | PortMappingSnapshot |
| mappings.remove | { id } | { id } |
| mappings.start | { id } | PortMappingSnapshot |
| mappings.stop | { id } | PortMappingSnapshot |
| mappings.importCsv | { csv } | { created: PortMappingConfig[] } |
| mappings.exportCsv | {} | { csv, fileName } |
| network.localAddresses | {} | { address, family, internal, interfaceName }[] |
| shares.list | {} | ShareSnapshot[] |
| shares.start | ShareConfig | ShareSnapshot |
| shares.stop | { sessionId } | { sessionId } |
| appLogs.status | {} | AppLogStatus |
| sessionLogs.list | {} | SessionLogSnapshot[] |
| sessionLogs.start | { sessionId, addTimestamp, stripAnsi } | SessionLogSnapshot |
| sessionLogs.update | { sessionId, patch } | SessionLogSnapshot |
| sessionLogs.stop | { sessionId } | SessionLogSnapshot |

所有 endpoint 都显式校验 payload 类型，不直接信任 TypeScript cast。CSV 使请求体变大，因此 createHttpHandler 按原始字节累计，超过 2 MiB 返回 413 风格 RpcResult 并停止继续缓存。

新增领域错误码：

| code | 含义 |
|---|---|
| PORT_IN_USE | 监听地址/端口被占用 |
| ADDRESS_INVALID | 监听地址或目标地址不合法 |
| TARGET_UNREACHABLE | 目标解析、连接或发送失败 |
| MAPPING_NOT_FOUND | 映射 id 不存在 |
| MAPPING_STATE | 当前状态不允许该操作 |
| SHARE_ALREADY_ACTIVE | 会话已有共享实例 |
| SHARE_NOT_FOUND | 会话没有共享实例 |
| CLIENT_LIMIT | 达到共享客户端上限 |
| LOG_NOT_ACTIVE | 会话日志未开启 |
| IO_ERROR | 持久化或日志文件 I/O 失败 |
| IO_BACKPRESSURE | 日志或共享客户端缓冲超过上限 |
| IMPORT_INVALID | CSV 格式、行数或字段校验失败 |

继续返回 { code, message } 语义；message 只描述字段/资源和安全的网络错误，不含原始凭据。旧 endpoint 行为和现有错误码保持兼容。

### 2.12 数据面事件

/term-io 保留现有 output 和 status 帧，并新增：

~~~typescript
type RuntimeOutFrame =
  | { kind: 'mapping-status'; snapshot: PortMappingSnapshot }
  | { kind: 'mapping-removed'; id: string }
  | { kind: 'share-status'; snapshot: ShareSnapshot }
  | { kind: 'share-removed'; sessionId: string }
  | { kind: 'session-log-status'; snapshot: SessionLogSnapshot }
~~~

- TermIoConnection 构造时订阅三个 manager，close 时逐个取消。
- 新帧仅做增量更新，不在 WS 建连时发送全量；页面首次进入和断线重连时分别调用 list RPC。
- 旧客户端会忽略未知 kind，新 host 仍接受原 attach/detach/input/resize，上下行兼容。
- 计数类通知由 manager 合并到最多每 500ms 一次；启动、停止、错误和删除不延迟。

### 2.13 UI

#### 右侧管理区

增加顶层页签：

- 连接：原 ConnectionsPanel 原样嵌入，SSH/Telnet 子页签和表单行为不变。
- 端口映射：顶部为新增/编辑表单；中部为排序选择；底部为映射卡片列表和导入/导出按钮。
- 日志：显示应用日志级别、当前文件、文件数量/大小；显示所有会话日志状态和文件路径。

端口映射卡片显示：

- TCP/UDP、localAddr:localPort → redirectAddr:redirectPort。
- 状态色、autoStart、activeCount、双向字节、最近错误。
- running 时显示停止，stopped/error 时显示启动；编辑、删除均有清晰进行中状态，防止重复点击。
- CSV 导入先显示将创建的数量；服务端返回成功后刷新。导出直接下载 UTF-8 CSV。

#### 单终端操作

TermView 标题栏新增两个紧凑按钮：

- 共享：打开 SessionActionsDialog 的共享区，填写监听地址、端口、客户端上限和欢迎语；启动前必须勾选风险确认。运行后显示地址、客户端数、客户端列表和停止按钮。
- 日志：打开日志区，启停当前会话日志，设置时间戳和 ANSI 清理，显示/复制路径并提示“不轮转，可能持续占用磁盘”。

关闭、最小化、最大化按钮的现有顺序和行为保持不变；新按钮放在其左侧。对话框使用 portal 或覆盖层，不能改变 xterm 尺寸计算。

#### 可访问性和反馈

- 所有图标按钮必须有 title 和可读 aria-label；不能只靠颜色表达状态。
- 表单 label 与 input 关联，错误显示在对应字段附近。
- 启停期间禁用冲突操作并显示“启动中/停止中”。
- 外部监听/无认证/可写警告使用文本，不只用警告图标。
- 字节数使用 B/KiB/MiB/GiB 格式，但保留原始整数用于测试和状态。

### 2.14 插件装配与关闭顺序

src/index.ts 使用同一个 dataDir：

~~~text
dataDir/
  connections.json                 既有，不改
  port-mappings.json               新增
  log/app_*.log                    新增，5 MiB × 5
  session_logs/session_*.log       新增，不轮转
~~~

启动：

1. 创建 AppLogger。
2. 创建 ConnectionStore 和 SessionManager。
3. 创建 PortMappingStore/Manager、SessionShareManager、SessionLogManager。
4. 注册现有工具、歧义处理、扩展后的 RPC 与 WS。
5. 异步执行 mappings.startAuto()；错误写应用日志而不拒绝插件加载。

卸载按以下顺序触发一次幂等 shutdown：

1. 禁止新 RPC 启动操作。
2. stopAll shares，取消会话订阅并关闭外部客户端。
3. closeAll session logs，刷盘。
4. stopAll mappings，释放监听端口和转发 socket。
5. sessions.closeAll，关闭 SSH/Telnet。
6. AppLogger 写 plugin.stopped 后 close。

现有 ctx.effect 语义保持不变：setup 函数返回 disposer。若 Cordis 不等待异步 disposer，disposer 仍立即启动 shutdown Promise，并保证所有管理器自身拒绝新操作；测试等待暴露的 close Promise 验证资源最终释放。

## 3. 关键决策与未采用方案

| 决策 | 采用 | 未采用及原因 |
|---|---|---|
| 端口映射类型 | 独立 Node TCP/UDP 代理 | SSH local forwarding：与 intent 的“独立于 SSH”冲突 |
| I/O 模型 | Node 事件循环、stream/dgram | 移植 IPOP 线程/select/busy-loop：不符合当前 TS host，且存在 CPU/竞态问题 |
| 共享注入点 | SessionManager.subscribe/write | 修改 SSH/Telnet transport：会重复协议逻辑并破坏公共会话池边界 |
| 共享权限 | 对外、无认证、完全可写 | 令牌和只读默认：产品负责人已明确选择 IPOP 行为 |
| 共享历史 | 不回放 | 自动发送环形缓冲：会泄露共享开始前内容，且 intent 只要求实时输出 |
| 会话日志输入 | 不直接记录 | 在 write 路径记录：会捕获密码且与产品决定冲突 |
| 会话日志轮转 | 不轮转、不清理 | 20 MiB × 20：产品负责人明确采用 IPOP 持续增长行为 |
| 状态通信 | 扩展现有 /term-io | 新建第三条 WS：增加生命周期与重连复杂度 |
| CSV | 浏览器选取/下载，host 解析/生成 | host 临时文件：无必要且增加文件权限/清理问题 |
| Agent 能力 | 不新增 tm_* | 自动开放端口：超出已接受 intent |

## 4. 应用的标准

- 当前仓库约定：TypeScript strict、React 18、Node ESM、host/client 双半包。
- DSH/Cordis：apply(ctx)、inject、ctx.effect setup/disposer 语义、webServer.register/registerUpgrade。
- 当前插件架构：SessionManager 是唯一公共会话池；控制面 /term-manager；数据面 /term-io。
- 当前 UI：client/styles.ts 集中样式、.tm- 前缀、--dsw-* token、中文文案。
- 当前安全约定：AI 发送走 CommandGuard，人工与共享客户端输入不走；错误和日志不含凭据；控制面保持 loopback。
- REVIEW.md：缺陷、安全、spec/plan 合规三轮评审，发现必须给文件/行证据，nit 最多 5 条。

## 5. 陷阱与风险

1. 【已接受，高风险】共享端口对外、无认证且可写。任何可连通者都能查看输出并控制设备；实现不能悄悄增加认证改变产品决定，但必须在 UI 明示。
2. 【已接受，中风险】会话日志没有轮转和清理，长会话可能耗尽磁盘；必须默认关闭、显示路径和持续增长提示。
3. 共享客户端输入等价于人工输入，会绕过 AI CommandGuard 并可能与 AI 命令交错。这不是 bug，但必须在启动警告中说明。
4. 只记录“设备输出”不等于日志中一定没有用户命令：远端设备若回显输入，回显内容会作为设备输出出现。
5. UDP 没有真实连接，来源端点必须独立；不能共用一个目标 socket，否则并发客户端响应可能串包。
6. UDP 域名可能同时有 A/AAAA；本次 start 时选 dns.lookup 返回的一个地址，DNS 变化要重启映射才生效。
7. 预检查端口可用与实际 bind 之间有竞态；实际 listen/bind 错误是唯一权威结果。
8. Node socket 的 error 和 close 可能连续到达；清理必须幂等，计数不能重复递减。
9. AppLogger 不能记录原始 RPC payload 或错误堆栈，因为其中可能含连接密码/私钥。
10. ANSI 序列可能跨输出 chunk；正则按块清理会把残片写进日志，必须用状态机。
11. session log WriteStream.end 要等待 finish；直接 destroy 会丢失末尾数据。
12. CSV 中 IPv6 的 host:port 必须使用方括号；错误报告给行号，不能把整行原样写进应用日志。
13. 当前控制面 handler 没有请求体上限；为 CSV 增加上限时必须保持普通 RPC 和 OPTIONS 行为不变。
14. 当前 /term-io 只校验 Host 是否 loopback；本次不扩大控制面信任边界，共享 server 是唯一对外监听面。

## 6. 开放问题

产品问题均已由 2026-09-02 的 intent 评审解决。本规格没有阻塞 Build 的开放问题。

实现中若出现以下情况，必须修订本规格或后续 plan，而不能自行扩展：

- 需要共享认证、只读模式或共享配置持久化；
- 需要 Agent 工具操作端口；
- 需要会话日志轮转、删除、下载或内容查看；
- 需要 SSH tunnel、反向代理或公网中继；
- 需要新增生产依赖或改变 DSH 核心。

## 7. 验证计划

### 7.1 单元与集成测试

| 测试文件 | 主要证明 |
|---|---|
| tests/port-mapping-store.spec.ts | JSON 加载/持久化、字段校验、批量原子导入、3/5/6 字段 CSV、IPv6、重复冲突、导出 |
| tests/port-mapping-tcp.spec.ts | 多客户端双向转发、目标失败不关 listener、字节计数、半关闭、端口冲突、停止释放、IPv6（环境支持时） |
| tests/port-mapping-udp.spec.ts | 双向数据报、两来源隔离、零长度报文、空闲回收、队列/peer 上限、IPv4/IPv6、停止清理 |
| tests/session-share-manager.spec.ts | 多客户端广播、客户端写入、IAC 过滤/转义、CRLF 归一、无历史回放、慢客户端隔离、会话关闭清理 |
| tests/app-logger.spec.ts | 四级日志、写入顺序、5 MiB 轮转、最多 5 文件、敏感键清理、I/O 失败降级 |
| tests/session-log-manager.spec.ts | 默认关闭、只订阅输出、时间戳、跨 chunk ANSI、退格/CR、半行 flush、错误/背压、会话关闭 |
| tests/remotes.spec.ts | 全部新增 endpoint、payload 校验、错误码、CSV 上限、旧 endpoint 回归 |
| tests/ws-io.spec.ts | 三类状态帧、节流、关闭取消订阅、旧终端帧兼容 |
| tests/index.spec.ts | 新管理器装配、autoStart、严格关闭顺序、关闭幂等 |
| tests/client-ws.spec.ts | 新帧分发、未知帧忽略、重连后触发全量刷新 |

测试使用 tests/helpers.ts 扩展的本地 TCP/UDP echo 设备和假 SessionManager，不接触用户真实设备。占用端口均通过 listen(0) 获得，测试完成后登记清理。

### 7.2 回归和构建

实现完成、提交评审前必须执行：

~~~text
pnpm build
pnpm test
pnpm vitest run --coverage
~~~

- 既有测试全部通过，不以修改旧测试期望来掩盖回归。
- src-only 覆盖率不低于当前 vitest.config.ts 阈值 72/72/60/74。
- 若新增分支导致阈值仅勉强通过，优先补生命周期和错误分支测试。

### 7.3 本地端到端与 UI 验收

在不占用用户 3080 端口的前提下，继续使用 DSH 3180：

1. TCP：本地 echo target → 创建映射 → 两个客户端并发收发 → 停止后确认端口可重新绑定。
2. UDP：两个不同来源同时发不同 payload → 各自收到正确响应 → 空闲 peer 回收。
3. 自动启动：保存 autoStart 映射 → 重启插件 → UI 显示 running。
4. CSV：导出 → 删除配置 → 重新导入 → 字段一致，autoStart 保留。
5. 共享：打开模拟 SSH/Telnet → 启动共享 → 两个 telnet 客户端实时看输出并分别输入 → 停止/断开会话后端口释放。
6. 慢客户端：暂停一个共享客户端读取并持续制造输出 → 只断开慢客户端，xterm 和另一客户端持续正常。
7. 会话日志：开启时间戳和 ANSI 清理 → 产生彩色/退格/分块输出 → 停止后检查纯文本和末行。
8. 应用日志：制造端口冲突和共享连接/断开 → 日志存在事件但搜索不到测试密码和私钥。
9. UI：截取连接、端口映射、日志三个页签，以及共享风险确认和会话日志对话框的明暗主题截图。

### 7.4 Spec 合规检查

代码评审逐项检查：

- diff 只扩展当前插件，没有独立 app、C++/Python host 或新的 Agent 工具；
- 共享和会话日志只使用 SessionManager 公共接缝；
- IPOP 已知的 UDP 删除、赋值比较、IPv6 地址族、越界、泄漏、busy-loop、零长度报文和 Establish 错误均有对应实现或测试；
- 所有新增监听器、定时器、订阅、WriteStream、TCP/UDP socket 都有明确 owner 和关闭路径；
- 实际 diff 若偏离本规格，先更新本规格和获批 plan，再提交代码。

---

> 产品负责人批准本规格后进入 Build 计划阶段；在 plan.md 增量计划获得批准前，不修改实现代码。
