# API 契约审查报告 — dsh-terminal-manager
// fixme 
> 审查日期：2026-09-03
> 审查范围：`src/types/`（三份契约）+ 主线实现（`src/`）+ 浏览器半（`client/`）+ 传输层（`src/transport/`）
> 审查方法：逐文件提取接口/类型/错误码定义，跨模块比对命名、结构、单位、语义一致性
> 基线 commit：当前工作树（spec.md 2026-09-02 冻结版）

## 一、审查范围

| 层 | 文件 | 角色 |
|---|---|---|
| 契约 | `src/types/events.ts` | 事件总线声明 |
| 契约 | `src/types/session-api.ts` | 会话管理器公开面声明 |
| 契约 | `src/types/file-service.ts` | 文件服务声明 |
| 实现 | `src/session-manager.ts` | B4 心脏（implements SessionManagerApi） |
| 实现 | `src/connection-store.ts` | B1 连接存储 |
| 实现 | `src/tools.ts` | B6 AI 工具层 |
| 实现 | `src/remotes.ts` | B7a 控制面 HTTP |
| 实现 | `src/ws-io.ts` | B7b 数据面 WS |
| 实现 | `src/wait-policy.ts` | B5 完成判定 |
| 实现 | `src/command-guard.ts` | B8 命令守卫 |
| 实现 | `src/file-service.ts` | B10 文件服务实现 |
| 实现 | `src/transport/types.ts` | 传输层接口 |
| 实现 | `src/transport/ssh.ts` / `telnet.ts` | B2/B3 传输实现 |
| 实现 | `src/ext/index.ts` | 扩展模块挂载点 |
| 客户端 | `client/rpc.ts` / `ws.ts` | 浏览器半通道客户端 |

## 二、严重程度分级

- 🔴 **高**：会导致运行时错误或安全漏洞，必须修
- 🟠 **中**：增加维护成本、易在改动时引入 bug，建议修
- 🟡 **低**：命名/风格不一致，影响可读性，可择机修
- ✅ **符合预期**：设计如此，记录在案

## 三、问题清单

### 🔴 P1 — 连接超时参数命名与单位冲突

| 项 | 内容 |
|---|---|
| 位置 | `ConnectTarget.connectTimeoutMs`（session-api.ts，毫秒）<br/>`ConnectionConfig.handshakeTimeoutSec`（connection-store.ts，秒）<br/>`TransportConnectOptions.connectTimeoutMs`（transport/types.ts，毫秒） |
| 现状 | 同一概念「连接建立超时」在三处用两种命名、两种单位：<br/>- 前端/会话层用 `connectTimeoutMs`（毫秒）<br/>- 连接配置持久化用 `handshakeTimeoutSec`（秒，UI 可选 15/30/60/120/180）<br/>- 传输层用 `connectTimeoutMs`（毫秒） |
| 转换点 | `session-manager.ts` `connectByConnId` 与 `reconnect` 各做一次 `connectTimeoutMs: conn.handshakeTimeoutSec * 1000` |
| 风险 | 单位转换散落多处，新增调用路径时极易漏乘 1000 或误用秒数当毫秒，导致超时被放大/缩小 1000 倍 |
| 建议 | 统一为单一字段名 + 单一单位（推荐毫秒 `connectTimeoutMs`），UI 层做秒→毫秒换算，配置层不再存秒 |

### 🔴 P2 — 凭据结构形态冲突（扁平 vs 嵌套）

| 项 | 内容 |
|---|---|
| 位置 | `ConnectTarget`：扁平 `password? / privateKey? / passphrase?`（session-api.ts）<br/>`ConnectionConfig`：嵌套 `auth?: { kind:'password', password } \| { kind:'key', privateKey, passphrase? }`（connection-store.ts）<br/>`TransportConnectOptions`：扁平 `password? / privateKey? / passphrase?`（transport/types.ts） |
| 现状 | 两套结构表达同一凭据：传输层/会话层用扁平，存储层用 `auth` 嵌套判别联合 |
| 转换点 | `session-manager.ts` `connect()` 把扁平 → 嵌套入库；`connectByConnId` / `reconnect` 把嵌套 → 扁传传输 |
| 风险 | 转换逻辑重复 3 处，每处都要分别处理 password / key / passphrase，遗漏 `passphrase` 会导致密钥连接失败且不易定位 |
| 建议 | 契约层统一为一种形态（推荐嵌套 `auth` 判别联合，类型更安全）；传输层接收 `auth` 后内部展平 |

### 🟠 P3 — `wait` 字段跨层语义重载

| 项 | 内容 |
|---|---|
| 位置 | `SendOptions.wait?: WaitPolicyConfig`（session-api.ts，**对象**）<br/>`SendArgs.wait?: 'complete' \| 'immediate'`（tools.ts，**字符串枚举**）<br/>`remotes.ts` `sessions.send` 端点 `wait?: SendOptions['wait']`（**对象**） |
| 现状 | 同名 `wait` 在三层含义不同：AI 工具层是「等不等」的字符串，会话层/控制面层是「怎么等」的配置对象 |
| 转换点 | `tools.ts` `tm_send.execute` 按 `args.wait === 'immediate'` 分流到 `sendImmediate` / `sendAndWait`，`WaitPolicyConfig` 经 `waitOptions(args)` 从 `quietMs/timeoutMs` 拼装 |
| 风险 | 阅读时极易混淆；若有人把字符串 `'complete'` 误传给 `sendAndWait.options.wait`，运行时不会报错（结构类型兼容）但 `WaitPolicy` 构造会拿到错误形状 |
| 建议 | 工具层改名 `mode?: 'complete' \| 'immediate'`，与 `wait: WaitPolicyConfig` 解耦 |

### 🟠 P4 — `BroadcastEntry` 契约嵌套 vs 工具 schema 展平

| 项 | 内容 |
|---|---|
| 位置 | `BroadcastEntry = { sessionId, outcome, result?: SendResult, code? }`（session-api.ts，**嵌套 result**）<br/>`BROADCAST_ENTRY_SCHEMA = { sessionId, outcome, output?, waitReason?, code? }`（tools.ts，**展平**） |
| 转换点 | `tools.ts` `tm_send_all.execute` 末尾 `raw.map(e => ({ sessionId, outcome, ...(e.result?.output ...), ...(e.result?.waitReason ...) }))` |
| 风险 | 契约定义嵌套，工具输出 schema 展平，两套结构并存；`additionalProperties: false` 的 schema 与契约形状不一致，类型生成会以哪边为准产生分歧 |
| 建议 | 二选一。推荐契约也展平（与 AI 消费的对齐），或工具层保留嵌套 `result` |

### 🟠 P5 — `TransportFactory` 参数类型与传输函数签名宽度不一致

| 项 | 内容 |
|---|---|
| 位置 | `TransportFactory = (target: ConnectTarget, callbacks) => Promise<Transport>`（session-manager.ts）<br/>`connectSsh(options: TransportConnectOptions, ...)` / `connectTelnet(options: TransportConnectOptions, ...)`（transport/*.ts） |
| 现状 | `ConnectTarget` 是 `TransportConnectOptions` 的超集（多 `protocol / label / newline / localEcho`）。`defaultTransportFactory` 把整个 `ConnectTarget` 传给只声明 `TransportConnectOptions` 的函数 |
| 风险 | TS 结构兼容能编译，但：① 传输层收到了它不需要的字段，语义边界模糊；② **分派依赖的 `target.protocol` 不在 `TransportConnectOptions` 类型里**——`defaultTransportFactory` 靠 `target.protocol` 选 SSH/Telnet，但 `TransportConnectOptions` 根本没有 `protocol` 字段，类型层面无法保证分派正确 |
| 建议 | 传输函数签名改为接收 `ConnectTarget`（或新增 `protocol` 到 `TransportConnectOptions`），让分派依赖的字段在类型里可见 |

### 🟠 P6 — 控制面 `sessions.send` 端点不过守卫，与 AI 路径隐式分流

| 项 | 内容 |
|---|---|
| 位置 | `SendOptions.guard?: GuardOptions`（session-api.ts）<br/>`remotes.ts` `sessions.send` 解构 `{ sessionId, command, source, wait, newline, submit }`——**不传 guard** |
| 现状 | 同一 `sendAndWait` 方法，AI 工具层（`tm_send`）必传 `guard: {}` 过守卫，控制面 `sessions.send`（编辑器/TC 执行）不过守卫。安全策略靠「是否传 guard」隐式区分 |
| 风险 | 注释写「编辑器路径：不过守卫」，但 TC 脚本/发送选中也是用户主动发起的命令，与 AI 路径同样可能含危险命令。当前完全依赖前端确认框兜底，后端无防线 |
| 建议 | 明确策略：要么控制面也传 `guard`（按来源决定），要么在契约/文档里显式声明「控制面 sessions.send 永远是可信用户路径，守卫只在 AI 工具层」并加测试锁定 |

### 🟠 P7 — 错误码三套独立定义，部分重叠且跨域复用

| 项 | 内容 |
|---|---|
| 位置 | `SessionErrorCode`（session-api.ts）：`SESSION_NOT_FOUND / SESSION_BUSY / DISCONNECTED / COMMAND_BLOCKED / SESSION_NOT_DISCONNECTED`<br/>`TransportErrorCode`（transport/types.ts）：`AUTH_FAILED / HOST_UNREACHABLE / CONN_TIMEOUT / PROTO_ERROR / DISCONNECTED`<br/>`FileErrorCode`（file-service.ts）：`VALIDATION / PATH_OUTSIDE_ROOT / NOT_FOUND / FILE_TOO_LARGE / SESSION_NOT_FOUND / DISCONNECTED / REMOTE_IO / UNSUPPORTED`<br/>`REMOTE_ERROR_CODES`（remotes.ts）：上述并集 |
| 现状 | `DISCONNECTED` 在三套重复定义；`SESSION_NOT_FOUND` 在 Session + File 两套；无单一权威枚举 |
| 风险 | 新增错误码时易漏更新并集；`FileErrorCode` 含 `SESSION_NOT_FOUND / DISCONNECTED` 跨域复用，语义模糊（文件操作报「会话不存在」） |
| 建议 | 抽一个 `src/types/errors.ts` 统一枚举 + 各域子集，或明确各域错误码不相交、转换时映射 |

### 🟠 P8 — `SESSION_NOT_FOUND` 错误码语义复用（会话 vs 连接配置）

| 项 | 内容 |
|---|---|
| 位置 | `SessionError.code = 'SESSION_NOT_FOUND'`（session-manager.ts，会话不存在）<br/>`StoreNotFoundError.code = 'SESSION_NOT_FOUND'`（connection-store.ts，**连接配置**不存在） |
| 现状 | 同一错误码表达两种不同语义：会话池里找不到会话 vs 存储里找不到连接配置 |
| 风险 | 前端/AI 收到 `SESSION_NOT_FOUND` 无法区分是「会话掉了」还是「连接配置被删了」，提示文案与重连策略难以精准 |
| 建议 | 连接配置不存在用独立码如 `CONNECTION_NOT_FOUND`，与会话区分 |

### 🟡 P9 — `SessionStatus` 与 `ConnectionStatus` 命名/取值差异

| 项 | 内容 |
|---|---|
| 位置 | `SessionStatus = 'connecting' \| 'open' \| 'closed' \| 'removed'`（session-api.ts）<br/>`ConnectionStatus = 'connecting' \| 'open' \| 'closed'`（client/ws.ts） |
| 现状 | `client/ws.ts` 的 `ConnectionStatus` 实指 **WS 连接状态**，非会话状态，少了 `removed`，但命名与 `SessionStatus` 极近 |
| 风险 | 名称相近易误读为同一概念；`removed` 在客户端不存在，状态机不对称 |
| 建议 | 客户端改名 `WsConnectionStatus`，明确是 WS 通道状态 |

### 🟡 P10 — WS 帧 `status` 类型两端不对称

| 项 | 内容 |
|---|---|
| 位置 | host `OutFrame`（ws-io.ts）：`{ kind:'status' } & SessionSnapshot`（强类型）<br/>client `InFrame`（ws.ts）：`{ kind:'status' } & Record<string, unknown>`（弱类型） |
| 现状 | status 帧在 host 端是 `SessionSnapshot`，客户端是 `Record<string, unknown>` |
| 风险 | 有意为之（客户端不 import host 类型，避免双半包耦合），但失去编译期校验，客户端取字段时无提示 |
| 建议 | ✅ 设计合理；可在 `client/` 维护一份 `SessionSnapshot` 镜像类型（手写或 codegen）恢复校验 |

### 🟡 P11 — `FileRpcAction` 契约与实现端点不同步

| 项 | 内容 |
|---|---|
| 位置 | `FileRpcAction = 'files.tree' \| 'files.read' \| 'files.write' \| 'files.dirs'`（file-service.ts 契约）<br/>`remotes.ts` dispatch 还实现了 `files.root`、`files.open` |
| 现状 | 契约声明的动作名是子集，实现有额外端点未入契约 |
| 风险 | 契约与实现漂移；`files.open` 不在 `FileService` 接口内（是主线自己的功能），但用了 `files.*` 命名空间 |
| 建议 | 把 `files.root / files.open` 补进 `FileRpcAction`，或在契约注释说明「FileRpcAction 仅列 FileService 接口对应的端点」 |

### 🟡 P12 — `SessionSnapshot.target` 拼接串 vs `ConnectTarget` 分字段

| 项 | 内容 |
|---|---|
| 位置 | `SessionSnapshot.target: string`（session-api.ts，`"host:port"` 拼接）<br/>`ConnectTarget.host / ConnectTarget.port`（分字段） |
| 转换点 | `session-manager.ts` `target: ${target.host}:${target.port}` |
| 现状 | 快照里 target 是拼接串，消费方要自己 `split(':')` 才能拿 host/port |
| 风险 | IPv6 地址含 `:` 会被误 split；前端展示与匹配要反复拆串 |
| 建议 | 快照里也存 `host` + `port` 分字段，`target` 保留为派生展示串或移除 |

### 🟡 P13 — `TmInputSource` 缺省规则分散三处

| 项 | 内容 |
|---|---|
| 位置 | `sourceOf(options, fallback)` = `options.source ?? (guard !== undefined ? 'ai' : fallback)`（session-manager.ts）<br/>`write()` 硬编码 `source: 'human'`<br/>`broadcast` 缺省 `fallback = 'broadcast'`<br/>`remotes.ts` `sessions.send` 缺省 `source ?? 'script'` |
| 现状 | 输入来源的缺省规则分散在会话管理器、控制面两处，无单一权威 |
| 风险 | 新增入口时易漏定缺省；`script` 缺省只在控制面，会话管理器层不知 `script` 概念 |
| 建议 | 缺省规则集中到 `sourceOf` 一处，控制面显式传 `source` 不靠缺省 |

### ✅ P14 — `SessionManagerApi` 公开面 vs `SessionManager` 实现额外方法

| 项 | 内容 |
|---|---|
| 位置 | `SessionManagerApi`（session-api.ts）14 个方法<br/>`SessionManager implements SessionManagerApi` 额外有 `findConnectionByTarget / resize / closeAll`（非公开面） |
| 现状 | 主线 `tools.ts / remotes.ts / ws-io.ts` 直接用 `SessionManager` 实例的非公开面方法；扩展模块经 `ExtensionDeps.sessions: SessionManagerApi` 只看契约面 |
| 说明 | ✅ 设计意图（CLAUDE.md：「扩展模块只 import `src/types/`，不 import 主线实现」）。契约只约束扩展模块，主线依赖未声明方法是允许的 |
| 风险 | 低：主线与实现强耦合，重构 `SessionManager` 时主线会一起改；但契约面不完整，新接手者可能误以为 `SessionManagerApi` 是全部能力 |
| 建议 | 在 `SessionManagerApi` 注释里显式列出「主线额外使用但不对扩展开放的方法」 |

### ✅ P15 — `FileServiceError` 契约 interface vs 实现 class

| 项 | 内容 |
|---|---|
| 位置 | 契约 `FileServiceError extends Error`（interface，file-service.ts 契约）<br/>实现 `class FileServiceError extends Error implements FileServiceErrorShape`（file-errors.ts） |
| 说明 | ✅ 合理：契约是形状声明，实现是真实类，`path-security.ts` 与 `file-service.ts` 共用实现类而不互相 import |
| 建议 | 无需改动 |

## 四、问题汇总

| 编号 | 严重 | 一句话 | 涉及文件 |
|---|---|---|---|
| P1 | 🔴 高 | 连接超时命名/单位三处不一致（ms vs sec） | session-api / connection-store / transport/types |
| P2 | 🔴 高 | 凭据扁平 vs 嵌套两套结构，转换散落 3 处 | session-api / connection-store / transport/types |
| P3 | 🟠 中 | `wait` 跨层语义重载（字符串 vs 对象） | session-api / tools / remotes |
| P4 | 🟠 中 | `BroadcastEntry` 契约嵌套 vs 工具 schema 展平 | session-api / tools |
| P5 | 🟠 中 | `TransportFactory` 参数宽于传输函数签名，分派字段不在类型里 | session-manager / transport/* |
| P6 | 🟠 中 | 控制面 `sessions.send` 不过守卫，与 AI 路径隐式分流 | remotes / session-api |
| P7 | 🟠 中 | 错误码三套独立定义，`DISCONNECTED` 等重叠 | session-api / transport/types / file-service |
| P8 | 🟠 中 | `SESSION_NOT_FOUND` 同时表示会话/连接配置不存在 | session-manager / connection-store |
| P9 | 🟡 低 | `SessionStatus` vs `ConnectionStatus` 命名近、取值不同 | session-api / client/ws |
| P10 | 🟡 低 | WS status 帧 host 强类型 / client 弱类型 | ws-io / client/ws |
| P11 | 🟡 低 | `FileRpcAction` 契约缺 `files.root / files.open` | file-service 契约 / remotes |
| P12 | 🟡 低 | `SessionSnapshot.target` 拼接串，IPv6 不安全 | session-api / session-manager |
| P13 | 🟡 低 | `TmInputSource` 缺省规则分散三处 | session-manager / remotes |
| P14 | ✅ | 契约面不含主线专用方法（设计如此） | session-api / session-manager |
| P15 | ✅ | `FileServiceError` 契约 interface + 实现 class（合理） | file-service 契约 / file-errors |

**统计**：🔴 高 2 项 · 🟠 中 6 项 · 🟡 低 5 项 · ✅ 符合预期 2 项

## 五、优先修复建议

### 第一优先级（🔴 高，影响正确性）

1. **P1 统一连接超时**：全链路改用 `connectTimeoutMs`（毫秒），UI 层做秒→毫秒换算，删除 `handshakeTimeoutSec` 或仅作 UI 展示字段。
2. **P2 统一凭据结构**：契约层统一为嵌套 `auth` 判别联合，传输层内部展平，消除 3 处转换。

### 第二优先级（🟠 中，影响维护成本与安全边界）

3. **P3 工具层 `wait` 改名 `mode`**：与 `WaitPolicyConfig` 解耦，消除语义重载。
4. **P4 `BroadcastEntry` 二选一**：推荐契约展平，与 AI 消费 schema 对齐。
5. **P5 传输函数签名补 `protocol`**：让分派依赖的字段在类型里可见，或改收 `ConnectTarget`。
6. **P6 控制面守卫策略显式化**：在契约/文档声明 `sessions.send` 的安全边界，或统一过守卫。
7. **P7 错误码统一枚举**：抽 `src/types/errors.ts`，各域子集，消除 `DISCONNECTED` 重复。
8. **P8 连接配置独立错误码**：`CONNECTION_NOT_FOUND` 与会话区分。

### 第三优先级（🟡 低，择机清理）

9. P9 客户端 `ConnectionStatus` → `WsConnectionStatus`。
10. P11 `FileRpcAction` 补 `files.root / files.open` 或注释说明范围。
11. P12 `SessionSnapshot` 存 `host + port` 分字段。
12. P13 `TmInputSource` 缺省规则集中到 `sourceOf`。

## 六、契约健康度评估

| 维度 | 评分 | 说明 |
|---|---|---|
| 契约与实现一致性 | 7/10 | 三份契约基本被实现遵守；P1/P2/P4 存在形状漂移 |
| 跨模块命名一致性 | 6/10 | 同概念多命名（超时、凭据、wait）、错误码重叠 |
| 类型安全度 | 7/10 | P5 分派字段不在类型里、P10 客户端弱类型、P12 拼接串 |
| 安全边界清晰度 | 7/10 | P6 守卫策略隐式分流、P8 错误码语义复用 |
| 扩展模块隔离度 | 9/10 | `src/types/` 纯声明 + 扩展只依赖契约，隔离做得好 |
| 文档与代码同步 | 8/10 | spec.md 详尽；P11 契约与实现端点小漂移 |

**综合**：契约体系整体健康，扩展模块隔离是亮点；主要风险集中在「同概念多形态」（P1/P2/P3/P4）与「错误码治理」（P7/P8），建议在九月迭代中优先处理两个 🔴 高项。

---

*本报告由静态接口比对生成，未运行动态检查。修复后建议跑 `pnpm test`（312 项基线）确认无回归。*
