# API 契约审查报告 — dsh-terminal-manager

> 审查日期：2026-09-05（port-log 扩展模块接入后复审）
> 上次审查：2026-09-04（S5 后）
> 审查范围：`src/types/`（三份契约）+ 主线实现（`src/`）+ 传输层（`src/transport/`）+ 扩展模块（`src/ext/port-log/`）+ 浏览器半（`client/`）
> 审查方法：逐文件提取接口/类型/错误码定义，跨模块比对命名、结构、单位、语义一致性
> 基线：`f2a5f83`（Merge origin/dev into feat/sep-s5-transfer，含 port-log 扩展）
> 修复跟进：2026-09-07 **P1 / P2（两个 🔴 高项）已修复**——连接超时统一毫秒、凭据结构统一嵌套 `auth`；见各条目「修复」行与第六节末尾「修复跟进」

## 一、本次变更概要

同事开发并合入 **port-log 扩展模块**（端口映射 + 会话共享 + 会话日志 + 应用日志）。关键变化：

| 变化 | 说明 |
|---|---|
| 契约层 | **三份契约文件仍均未改动**。port-log 严守「只依赖 `src/types/` 契约，不 import 主线实现，不改契约」 |
| 新增模块 | host 半 `src/ext/port-log/`（16 文件）+ client 半 `client/ext/port-log/`（7 文件） |
| 挂载 | `src/ext/index.ts` `registerExtensions` → `registerPortLogExtension`；`client/ext/index.tsx` → `registerPortLogClient` |
| HTTP 路由 | port-log 注册前缀路由 `/term-manager/ext/port-log`（挂在主线 `/term-manager` 下）+ SSE `/events` |
| 事件订阅 | port-log 订阅 `TmEventBus` 的 `output`/`status`/`file` 事件（会话日志订阅 output，应用日志订阅 status/file） |
| 会话面使用 | port-log 经 `SessionManagerApi` 用 `get`/`list`/`subscribe`/`write`（共享会话：外部 Telnet 客户端连入 → subscribe 拿输出 + write 注入输入） |
| 错误码 | 新增第四套 `PortLogErrorCode`（11 个，独立） |
| 推送通道 | port-log 用 SSE（HTTP `/events`）推运行时事件给前端，与主线 WS `/term-io` 并存 |

> 本次审查同时覆盖 S5（远端文件传输，2026-09-04 已审）的累积变化。下文 P1–P15 为基线问题，P16–P23 为 S5 引入，P24–P30 为 port-log 引入。

## 二、严重程度分级

- 🔴 **高**：会导致运行时错误或安全漏洞，必须修
- 🟠 **中**：增加维护成本、易在改动时引入 bug，建议修
- 🟡 **低**：命名/风格不一致，影响可读性，可择机修
- ✅ **符合预期**：设计如此，记录在案
- 🆕 **本轮新增**

## 三、问题清单

### 🔴 P1 — 连接超时参数命名与单位冲突

| 项 | 内容 |
|---|---|
| 位置 | `ConnectTarget.connectTimeoutMs`（毫秒）<br/>`ConnectionConfig.handshakeTimeoutSec`（秒）<br/>`TransportConnectOptions.connectTimeoutMs`（毫秒） |
| 风险 | 转换散落 `session-manager.ts` 多处，易漏乘 1000 |
| 建议 | 统一为 `connectTimeoutMs`（毫秒），UI 层做换算 |
| 修复 | ✅ 2026-09-07：`ConnectionConfig.handshakeTimeoutSec`（秒）删除，改名 `connectTimeoutMs`（毫秒），契约/存储/传输选项三处同名同单位；`session-manager.ts` 删 2 处 `* 1000` 转换（`connectByConnId` / `reconnect`）直接透传；UI 仍以秒展示（15/30/60/120/180 下拉框），`ConnectionsPanel` 保存 ×1000、回显 ÷1000 |

### 🔴 P2 — 凭据结构形态冲突（扁平 vs 嵌套）

| 项 | 内容 |
|---|---|
| 位置 | `ConnectTarget`/`TransportConnectOptions` 扁平 `password?/privateKey?/passphrase?`<br/>`ConnectionConfig` 嵌套 `auth?: { kind, ... }` |
| 风险 | 转换重复 3 处，易遗漏 `passphrase` |
| 建议 | 契约层统一为嵌套 `auth` 判别联合 |
| 修复 | ✅ 2026-09-07：契约层（`src/types/session-api.ts`）新增 `AuthConfig` 判别联合（`{ kind:'password', password } \| { kind:'key', privateKey, passphrase? }`）；`ConnectTarget` / `TransportConnectOptions` / `ConnectionConfig` 三处统一嵌套 `auth?`（connection-store 删本地定义，改 import + re-export）；`session-manager.ts` 3 处拆装转换（`connectByConnId` / `connect` / `reconnect`）删除，直接透传；边界转换收敛 2 处——`remotes.ts` `sessions.connect`（前端扁平 payload → auth）、`tools.ts` `tm_connect`（AI 扁平 password → auth），前端 RPC payload 与 AI 参数 schema 不变 |

### 🟠 P3 — `wait` 字段跨层语义重载

| 项 | 内容 |
|---|---|
| 位置 | `SendOptions.wait?: WaitPolicyConfig`（对象）<br/>`SendArgs.wait?: 'complete'\|'immediate'`（字符串，tools.ts）<br/>`remotes.ts` `sessions.send` `wait?: SendOptions['wait']`（对象） |
| 建议 | 工具层改名 `mode` |

### 🟠 P4 — `BroadcastEntry` 契约嵌套 vs 工具 schema 展平

| 项 | 内容 |
|---|---|
| 位置 | `BroadcastEntry = { ..., result?: SendResult }`（session-api.ts）<br/>`BROADCAST_ENTRY_SCHEMA = { ..., output?, waitReason? }`（tools.ts） |
| 建议 | 二选一，推荐契约展平 |

### 🟠 P5 — `TransportFactory` 参数类型与传输函数签名宽度不一致

| 项 | 内容 |
|---|---|
| 位置 | `TransportFactory` 收 `ConnectTarget`；`connectSsh`/`connectTelnet` 声明收 `TransportConnectOptions`（缺 `protocol`） |
| 现状 | 分派靠 `target.protocol`（不在 `TransportConnectOptions` 类型里）；`Transport.getSftp?()` 可选方法，Telnet 无此方法 |
| 建议 | 传输函数签名改收 `ConnectTarget`，或 `TransportConnectOptions` 补 `protocol` |

### 🟠 P6 — 控制面 `sessions.send` 不过守卫

| 项 | 内容 |
|---|---|
| 位置 | `remotes.ts` `sessions.send` 不传 `guard`；`tools.ts` `tm_send` 必传 `guard: {}` |
| 建议 | 显式声明安全边界或统一过守卫 |

### 🟠 P7 — 错误码多套独立定义，部分重叠

| 项 | 内容 |
|---|---|
| 位置 | `SessionErrorCode` / `TransportErrorCode` / `FileErrorCode` / **`PortLogErrorCode`（P26 新增第四套）**<br/>`DISCONNECTED`/`SESSION_NOT_FOUND` 跨套重复；`REMOTE_ERROR_CODES`（remotes.ts）并集不含 port-log 码 |
| 建议 | 抽 `src/types/errors.ts` 统一枚举 + 各域子集 |

### 🟠 P8 — `SESSION_NOT_FOUND` 语义复用

| 项 | 内容 |
|---|---|
| 位置 | `SessionError.code = 'SESSION_NOT_FOUND'`（会话不存在）<br/>`StoreNotFoundError.code = 'SESSION_NOT_FOUND'`（连接配置不存在） |
| 建议 | 连接配置用独立码 `CONNECTION_NOT_FOUND` |

### 🟠 🆕 P16 — B10 文件服务依赖传输层内部接口 `SftpLike`

| 项 | 内容 |
|---|---|
| 位置 | `SftpLike` 定义在 `transport/types.ts`；`file-service.ts` `FileSessionGateway.getSftp(): Promise<SftpLike>` 并 import 其类型 |
| 现状 | 突破 spec.md「传输层只被 B4 接触」约束；`SftpLike` 是协议无关门面（不暴露 ssh2），风险可控 |
| 建议 | 把 `SftpLike` 提到 `src/types/` 契约层，或显式记录二级边界 |

### 🟠 🆕 P17 — `tm_upload`/`tm_download` 树根基准与控制面不一致

| 项 | 内容 |
|---|---|
| 位置 | `tools.ts` 用全局 `workspaceRoot`；`remotes.ts` `files.uploadLocal` 用前端传入的 `LocalPathRef.root` |
| 风险 | AI 与人看到的「工作区」可能不一致（用户换目录后） |
| 建议 | AI 工具先调 `files.root` 查当前树根，或文档锁定语义 |

### 🟠 🆕 P24 — port-log 路由前缀与主线 `/term-manager` 重叠

| 项 | 内容 |
|---|---|
| 位置 | 主线 `registerRemotes` 注册前缀 `/term-manager`（remotes.ts）<br/>port-log `registerPortLogExtension` 注册前缀 `/term-manager/ext/port-log`（port-log/router.ts） |
| 现状 | 两个前缀路由重叠。主线 `createHttpHandler` 处理所有 `/term-manager/*`，port-log 路由处理 `/term-manager/ext/port-log/*`。分流依赖 `webServer.register` 的**最长前缀匹配**语义 |
| 风险 | 若 webServer 按注册顺序而非最长前缀匹配，主线先注册（index.ts 中 `registerRemotes` 先于 `registerExtensions`）会吃掉所有 `/term-manager/*`，port-log 路由永不触发。当前能工作说明 webServer 确实按最长前缀匹配，但这是**隐式依赖**，未在契约中声明 |
| 建议 | 在 index.ts 注释说明「依赖 webServer 最长前缀匹配」；或 port-log 改用独立前缀如 `/term-ext/port-log` 避开重叠 |

### 🟠 🆕 P25 — 安全栅栏重复实现（port-log vs 主线）

| 项 | 内容 |
|---|---|
| 位置 | 主线 `isTrustedOrigin(origin, host)`（remotes.ts）<br/>port-log `isAllowedRequest(request)`（port-log/router.ts）独立实现 loopback + Origin 校验 |
| 现状 | 两份安全栅栏代码逻辑相似但独立：主线 `isTrustedOrigin` 放行无 Origin / loopback / 同 Host；port-log `isAllowedRequest` 放行 loopback remoteAddress + 无 Origin / 同 Host |
| 风险 | 安全逻辑重复，未来收紧/放宽一处时另一处易漏改，导致两个前缀路由安全策略不一致 |
| 建议 | 抽公共 `src/security.ts`（或契约层）共享栅栏函数；或 port-log 显式 import 主线 `isTrustedOrigin`（但会破坏扩展模块不依赖主线实现的约定，不推荐） |

### 🟡 P9 — `SessionStatus` vs `ConnectionStatus` 命名/取值差异

| 项 | 内容 |
|---|---|
| 位置 | `SessionStatus = 'connecting'\|'open'\|'closed'\|'removed'`<br/>`ConnectionStatus = 'connecting'\|'open'\|'closed'`（client/ws.ts，WS 连接状态） |
| 建议 | 客户端改名 `WsConnectionStatus` |

### 🟡 P10 — WS 帧 `status` 类型两端不对称

| 项 | 内容 |
|---|---|
| 位置 | host `OutFrame` status `& SessionSnapshot`（强类型）<br/>client `InFrame` status `& Record<string, unknown>`（弱类型） |
| 说明 | ✅ 有意为之（客户端不 import host 类型） |

### 🟡 P11 — `FileRpcAction` 契约与实现端点不同步

| 项 | 内容 |
|---|---|
| 位置 | `FileRpcAction = 'files.tree'\|'files.read'\|'files.write'\|'files.dirs'`（4 个）<br/>实现：上述 4 + `files.root` + `files.open` + `files.remoteTree` + `files.uploadLocal` + `files.downloadToLocal` + HTTP `files/upload` + `files/download` |
| 风险 | 契约 4 个端点是实现的子集，`FileRpcAction` 已失去索引价值 |
| 建议 | 删除 `FileRpcAction` 改用注释索引，或补全 |

### 🟡 P12 — `SessionSnapshot.target` 拼接串 vs `ConnectTarget` 分字段

| 项 | 内容 |
|---|---|
| 位置 | `SessionSnapshot.target: string`（`"host:port"`）<br/>`ConnectTarget.host/port`（分字段） |
| 风险 | IPv6 含 `:` 误 split |
| 建议 | 快照存 `host + port` 分字段 |

### 🟡 P13 — `TmInputSource` 缺省规则分散

| 项 | 内容 |
|---|---|
| 位置 | `sourceOf`（session-manager.ts）+ `write()` 硬编码 + `broadcast` 缺省 + `remotes.ts` `sessions.send` 缺省 'script' |
| 建议 | 集中到 `sourceOf` 一处 |

### 🟡 🆕 P18 — `FileProgressFrame` 两端形状不对称

| 项 | 内容 |
|---|---|
| 位置 | host `FileProgressFrame`（`TransferProgress` 强类型，op/sessionId/remotePath/transferred 必填）<br/>client `FileProgressFrame`（ws.ts，所有字段可选） |
| 说明 | 与 P10 同模式，有意为之 |

### 🟡 🆕 P19 — `TransferResult` 契约 vs 工具 schema vs 控制面返回不一致

| 项 | 内容 |
|---|---|
| 位置 | 契约 `TransferResult = { ok: true, ... }`（literal true）<br/>工具 `TRANSFER_RESULT_SCHEMA` `ok: boolean`（放宽）<br/>控制面返回 `{ ...result, transferId }`（多 transferId） |
| 建议 | 工具 schema `ok` 用 `const: true`；控制面返回类型显式声明 |

### 🟡 🆕 P20 — `UploadSource.kind` vs `SftpPutSource.kind` 判别标签不一致

| 项 | 内容 |
|---|---|
| 位置 | 契约 `UploadSource` `kind: 'local'`<br/>传输层 `SftpPutSource` `kind: 'path'` |
| 建议 | 统一 kind 标签 |

### 🟡 🆕 P21 — `FileSessionGateway` 定义在实现文件而非契约层

| 项 | 内容 |
|---|---|
| 位置 | `FileSessionGateway` 定义在 `src/file-service.ts`（实现文件），不在 `src/types/` |
| 建议 | 若 P16 把 `SftpLike` 提到契约层，则同提 `FileSessionGateway` |

### 🟡 🆕 P22 — B7a → B7b 反向依赖（`broadcastFileProgress`）

| 项 | 内容 |
|---|---|
| 位置 | `index.ts` `wsIo = registerWsIo(...)` 先于 `registerRemotes(..., broadcastFileProgress: wsIo.broadcastFileProgress)` |
| 说明 | ✅ 显式接线可控，装配顺序是隐式约束 |

### 🟡 🆕 P23 — 契约注释陈旧（Telnet 模拟传输已砍）

| 项 | 内容 |
|---|---|
| 位置 | `src/types/file-service.ts` 注释仍提「Telnet 模拟 1MB」「命令模拟」 |
| 建议 | 更新注释：`UNSUPPORTED` = "Telnet 会话不支持文件传输" |

### 🟡 🆕 P26 — `PortLogErrorCode` 第四套独立错误码

| 项 | 内容 |
|---|---|
| 位置 | `PortLogErrorCode`（port-log/errors.ts）= VALIDATION/PORT_IN_USE/ADDRESS_INVALID/TARGET_UNREACHABLE/MAPPING_NOT_FOUND/MAPPING_STATE/SHARE_ALREADY_ACTIVE/SHARE_NOT_FOUND/IO_ERROR/IO_BACKPRESSURE/IMPORT_INVALID（11 个）<br/>`PortLogError.code` 不与主线 `REMOTE_ERROR_CODES` 合并 |
| 现状 | 扩展模块独立错误码，前端 port-log rpc.ts 自己处理 `PortLogRpcError` |
| 说明 | ✅ 扩展模块独立错误码合理（不污染主线）；但全局错误码治理更分散（现四套） |
| 建议 | 维持现状；若做 P7 统一枚举，port-log 码作为独立子集纳入 |

### 🟡 🆕 P27 — `RpcResult` 类型重复定义

| 项 | 内容 |
|---|---|
| 位置 | 主线 `remotes.ts` 用 `RpcResult`（来自 `@deepseek-ai/dsh-host-apiproxy/api`）<br/>port-log `router.ts` 本地定义 `RpcResult = { ok: true; value } \| { ok: false; error: { code, message, details } }` |
| 现状 | 两份 `RpcResult` 形状相似但独立，port-log 不依赖主线类型 |
| 说明 | ✅ 符合扩展模块隔离原则（不 import 主线/上游类型）；但形状漂移时无编译期对齐 |
| 建议 | 维持现状；若形状分歧可加注释指明对齐基准 |

### 🟡 🆕 P28 — SSE 与 WS 双实时推送通道并存

| 项 | 内容 |
|---|---|
| 位置 | 主线用 WS `/term-io`（output/status/file-progress 帧）<br/>port-log 用 SSE `/term-manager/ext/port-log/events`（mapping-status/share-status/session-log-status/app-log-status） |
| 现状 | 前端有两套实时通道：`TermWs`（WS）+ `subscribePortLogEvents`（EventSource/SSE） |
| 说明 | ✅ 设计选择：port-log 事件与主线终端流语义不同（运行时状态 vs 字节流），SSE 对扩展模块更简单（单向推送、HTTP 复用、无需 WS upgrade） |
| 风险 | 低：两套通道职责清晰；但前端实时连接数翻倍（WS + SSE），断线重连逻辑各写一份 |
| 建议 | 维持现状；文档说明「主线终端流走 WS、扩展运行时状态走 SSE」 |

### 🟡 🆕 P29 — `SessionLogSnapshot.state` vs `SessionStatus` 命名空间重叠

| 项 | 内容 |
|---|---|
| 位置 | port-log `SessionLogSnapshot.state = 'running' \| 'error'`（port-log/types.ts）<br/>主线 `SessionStatus = 'connecting' \| 'open' \| 'closed' \| 'removed'`（session-api.ts）<br/>port-log `MappingState = 'stopped' \| 'starting' \| 'running' \| 'stopping' \| 'error'`、`ShareSnapshot.state = 'running' \| 'stopped' \| 'error'` |
| 现状 | 多处用 `state`/`status` 描述状态，取值不同；`running` 在 port-log 多处复用 |
| 风险 | 命名易混，但分属不同模块，实际冲突低 |
| 建议 | 维持现状；port-log 类型加前缀注释说明所属域 |

### ✅ P14 — `SessionManagerApi` 公开面 vs 实现额外方法

| 项 | 内容 |
|---|---|
| 位置 | `SessionManagerApi` 14 个方法；`SessionManager` 额外有 `findConnectionByTarget / resize / closeAll / getSftp`（非公开面） |
| 现状 | 主线用非公开面方法；**port-log 扩展模块经 `SessionManagerApi` 契约面**用 `get/list/subscribe/write`，不碰非公开面 ✅ |
| 说明 | ✅ 设计意图验证通过：扩展模块确实只走契约面 |
| 建议 | 在 `SessionManagerApi` 注释列出「主线额外使用的方法」清单 |

### ✅ P15 — `FileServiceError` 契约 interface vs 实现 class

| 项 | 内容 |
|---|---|
| 说明 | ✅ 合理：契约形状声明，实现真实类，多处共用 |

### ✅ 🆕 P30 — 扩展模块契约隔离已验证

| 项 | 内容 |
|---|---|
| 位置 | `src/ext/port-log/` 全部 16 文件 |
| 验证 | ① 只 import `src/types/` 契约（`SessionManagerApi`/`TmEventBus`/`TmEvent`），不 import 主线实现文件 ✅<br/>② 契约层零改动 ✅<br/>③ 落盘在自己子目录 `dataDir/ext/port-log/` ✅<br/>④ 挂载点 `src/ext/index.ts` + `client/ext/index.tsx` 各一行调用 ✅ |
| 说明 | CLAUDE.md「两人并行开发」约定被严格遵守。扩展模块隔离度从「待接入」变为「已验证」 |
| 建议 | 无需改动 |

## 四、问题汇总

| 编号 | 严重 | 一句话 | 来源 | 状态 |
|---|---|---|---|---|
| P1 | 🔴 高 | 连接超时命名/单位三处不一致 | 基线 | **✅ 已修复 2026-09-07** |
| P2 | 🔴 高 | 凭据扁平 vs 嵌套两套结构 | 基线 | **✅ 已修复 2026-09-07** |
| P3 | 🟠 中 | `wait` 跨层语义重载 | 基线 |
| P4 | 🟠 中 | `BroadcastEntry` 契约嵌套 vs 工具展平 | 基线 |
| P5 | 🟠 中 | `TransportFactory` 参数宽于传输函数签名 | 基线 |
| P6 | 🟠 中 | 控制面 `sessions.send` 不过守卫 | 基线 |
| P7 | 🟠 中 | 错误码多套独立定义 | 基线 |
| P8 | 🟠 中 | `SESSION_NOT_FOUND` 语义复用 | 基线 |
| P16 | 🟠 中 | B10 依赖传输层 `SftpLike` | S5 |
| P17 | 🟠 中 | AI/人路径树根基准不一致 | S5 |
| P24 | 🟠 中 | port-log 路由前缀与主线重叠 | port-log |
| P25 | 🟠 中 | 安全栅栏重复实现 | port-log |
| P9 | 🟡 低 | `SessionStatus` vs `ConnectionStatus` | 基线 |
| P10 | 🟡 低 | WS status 帧两端类型不对称 | 基线 |
| P11 | 🟡 低 | `FileRpcAction` 契约缺端点 | 基线 |
| P12 | 🟡 低 | `SessionSnapshot.target` 拼接串 | 基线 |
| P13 | 🟡 低 | `TmInputSource` 缺省规则分散 | 基线 |
| P18 | 🟡 低 | `FileProgressFrame` 两端不对称 | S5 |
| P19 | 🟡 低 | `TransferResult` 三方不一致 | S5 |
| P20 | 🟡 低 | `UploadSource.kind` vs `SftpPutSource.kind` | S5 |
| P21 | 🟡 低 | `FileSessionGateway` 定义在实现文件 | S5 |
| P22 | 🟡 低 | B7a→B7b 反向依赖 | S5 |
| P23 | 🟡 低 | 契约注释陈旧 | S5 |
| P26 | 🟡 低 | `PortLogErrorCode` 第四套错误码 | port-log |
| P27 | 🟡 低 | `RpcResult` 类型重复 | port-log |
| P28 | 🟡 低 | SSE 与 WS 双推送通道 | port-log |
| P29 | 🟡 低 | `SessionLogSnapshot.state` vs `SessionStatus` 命名重叠 | port-log |
| P14 | ✅ | 契约面不含主线专用方法 | 基线 |
| P15 | ✅ | `FileServiceError` 契约+实现 | 基线 |
| P30 | ✅ | 扩展模块契约隔离已验证 | port-log |

**统计**：🔴 高 2（已于 2026-09-07 全部修复）· 🟠 中 10（+S5 两项 +port-log 两项）· 🟡 低 15（+S5 六项 +port-log 四项）· ✅ 符合预期 3（+port-log 一项）

## 五、优先修复建议

### 第一优先级（🔴 高）

1. ~~**P1 统一连接超时**：全链路 `connectTimeoutMs`（毫秒）~~ → ✅ 已完成（2026-09-07）。
2. ~~**P2 统一凭据结构**：契约层统一为嵌套 `auth` 判别联合~~ → ✅ 已完成（2026-09-07）。

### 第二优先级（🟠 中）

3. **P24 路由前缀重叠**：在 index.ts 注释说明依赖 webServer 最长前缀匹配，或 port-log 改独立前缀。
4. **P25 安全栅栏统一**：抽公共栅栏函数，避免两份安全逻辑漂移。
5. **P16 `SftpLike` 提到契约层**：确立 B10↔传输层二级边界。
6. **P17 AI 树根基准**：`tm_upload`/`tm_download` 运行时查 `files.root` 或文档锁定。
7. **P3 工具层 `wait` 改名 `mode`**。
8. **P4 `BroadcastEntry` 二选一**。
9. **P5 传输函数签名补 `protocol`**。
10. **P6 控制面守卫策略显式化**。
11. **P7 错误码统一枚举**（含 port-log 第四套）。
12. **P8 连接配置独立错误码**。

### 第三优先级（🟡 低）

13. **P11 删除 `FileRpcAction`**（已严重漂移）。
14. **P23 更新契约注释**（Telnet 模拟已砍）。
15. 其余低风险项择机清理。

## 六、契约健康度评估

| 维度 | 首次 | S5 后 | port-log 后 | 变化 |
|---|---|---|---|---|
| 契约与实现一致性 | 7/10 | 6/10 | 6/10 | — |
| 跨模块命名一致性 | 6/10 | 5/10 | 5/10 | — |
| 类型安全度 | 7/10 | 6/10 | 6/10 | — |
| 安全边界清晰度 | 7/10 | 7/10 | 6/10 | ↓ P25 栅栏重复 |
| 扩展模块隔离度 | 9/10 | 9/10 | **10/10** | ↑ P30 已验证 |
| 文档与代码同步 | 8/10 | 6/10 | 6/10 | — |
| 架构边界清晰度 | — | 7/10 | 6/10 | ↓ P24 路由重叠隐式依赖 |
| 实时通道一致性 | — | — | 7/10 | 🆕 P28 WS+SSE 并存 |

**综合**：port-log 接入后契约健康度**持平略降**（均分 5.9）。两个亮点：

1. **扩展模块隔离度满分 10/10**：port-log 严格遵守「只依赖契约、不改契约、不 import 主线实现、落盘自己子目录」，CLAUDE.md 并行开发约定验证通过。
2. **契约层三份文件累计零改动**：S5 + port-log 两轮大功能落地，契约层始终稳定，证明「契约冻结 + 实现并行」策略有效。

主要新增债务集中在**安全栅栏重复（P25）**与**路由前缀隐式依赖（P24）**——都是扩展模块与主线接缝处的问题，建议优先处理。两个 🔴 高项（P1/P2）自首次审查即存在，与 S5/port-log 无关，**已于 2026-09-07 修复**（见下）。

**修复跟进（2026-09-07）**：P1/P2 修复完成，`pnpm build` + `pnpm test` 全绿回归。修复后口径：
- **契约与实现一致性 7/10**：两处结构性冲突（超时单位、凭据形态）消除，契约层只剩一种凭据结构（`auth` 判别联合）。
- **跨模块命名一致性 7/10**：超时字段三处同名同单位（`connectTimeoutMs`），`* 1000` 散落转换清零。
- **类型安全度 7/10**：凭据单一判别联合后，漏传 `passphrase` 这类错误在编译期即可发现。
- 当前剩余债务首位为 🟠 中项：P24（路由前缀隐式依赖）、P25（安全栅栏重复）。

> **架构演进总结**：基线（6 工具）→ S5（8 工具 + SFTP 文件传输，突破 B4 唯一接触传输层）→ port-log（扩展模块接入，端口映射/会话共享/会话日志，新增 SSE 通道）。三份契约文件始终未动，是整个演进过程中最稳定的层。

---

*本报告由静态接口比对生成，未运行动态检查。修复后建议跑 `pnpm test` 确认基线无回归。*
