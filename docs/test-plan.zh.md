# 终端管理插件 — 测试方案

- 版本：v1.0
- 日期：2026-08-28
- 基线：84 项单测全绿，覆盖率 73/64/75/76（语句/分支/函数/行）

---

## 一、测试现状总览

### 1.1 已覆盖（按模块）

| 模块 | 文件 | 语句% | 分支% | 函数% | 行数 | 测试文件 | 评价 |
|---|---|---|---|---|---|---|---|
| B1 连接存储 | connection-store.ts | 91 | 86 | 100 | 97 | connection-store.spec | ✅ 扎实 |
| B2 SSH 传输 | ssh.ts | 82 | 62 | 87 | 86 | transport.spec | ⚠️ 错误分支不全 |
| B3 Telnet 传输 | telnet.ts | 78 | 59 | 83 | 84 | transport.spec | ⚠️ IAC 实现有 bug，测试未覆盖 |
| B4 会话管理器 | session-manager.ts | 87 | 75 | 93 | 91 | session-manager.spec | ✅ 核心扎实 |
| B5 完成判定 | wait-policy.ts | 97 | 93 | 100 | 100 | wait-policy.spec | ✅ 优秀 |
| B6 AI 工具层 | tools.ts | 66 | 54 | 61 | 72 | tools.spec | ❌ 错误路径大量缺失 |
| B7a 指令通道 | remotes.ts | 39 | 33 | 38 | 42 | remotes.spec | ❌ HTTP 路由 handler 未测 |
| B7b 数据流通道 | ws-io.ts | 51 | 35 | 40 | 51 | ws-io.spec | ❌ 生命周期未测 |
| 入口装配 | index.ts | 0 | 0 | 0 | 0 | 无 | ❌ 完全未测 |
| F1-F6 前端 | client/*.tsx | 0 | 0 | 0 | 0 | 无 | ❌ 完全未测 |

### 1.2 需求场景覆盖度（spec 1.2 的 14 个场景）

| 组 | 场景 | 编号 | 自动化状态 | 备注 |
|---|---|---|---|---|
| 配置管理 | 新建连接 | S1 | ✅ 覆盖 | connection-store + remotes + tools |
| 配置管理 | 编辑/删除 | S12 | ✅ 覆盖 | connection-store + remotes |
| 连接与观察 | 一键连接 | S2 | ✅ 覆盖 | transport + session-manager |
| 连接与观察 | 多设备同屏 | S3 | ✅ 覆盖 | session-manager 多会话 |
| 连接与观察 | 隐藏/显示窗格 | S13 | ❌ 无测试 | 纯前端交互 |
| 连接与观察 | 多终端聚焦 | S14 | ❌ 无测试 | 纯前端交互 |
| 手动操作 | 手动敲命令 | S4 | ✅ 覆盖 | session-manager + ws-io |
| 手动操作 | 广播到全部 | S5 | ✅ 覆盖 | session-manager broadcast |
| 手动操作 | 广播到部分 | S6 | ✅ 覆盖 | session-manager broadcast |
| AI 自动化 | AI 单机 | S7 | ✅ 覆盖 | tools.spec 完整生命周期 |
| AI 自动化 | AI 批量 | S8 | ✅ 覆盖 | tools.spec broadcast |
| AI 自动化 | AI 读现场 | S9 | ✅ 覆盖 | tools.spec + session-manager read |
| AI 自动化 | 人机共视 | S10 | ✅ 覆盖 | session-manager 共享会话池 |
| 异常 | 密码错/不通/掉线 | S11 | ✅ 覆盖 | transport + session-manager + command-guard |

**结论：12/14 场景有后端自动化测试；2 个纯前端 UI 场景（S13/S14）零覆盖。**

---

## 二、已知缺陷（测试中发现）

### 2.1 B3 Telnet IAC 协商实现缺陷

`src/transport/telnet.ts` 的 `stripIac` 函数存在以下问题：

| # | 缺陷 | 位置 | 影响 | 严重性 |
|---|---|---|---|---|
| D1 | IAC 字节在 TCP 分片边界丢失 | line 37 | chunk 末尾为 0xFF 时直接 break 丢掉，不会跨 chunk 拼接 → 设备输出乱码 | 🔴 高 |
| D2 | SB 子协商跨分片丢数据 | line 50-53 | IAC SB...IAC SE 横跨两个 TCP 包时，子协商后的数据全部丢失 | 🔴 高 |
| D3 | 协商逻辑自相矛盾 | line 40-43 vs line 85 | 连接时发 WILL ECHO，服务端回 DO ECHO 时却回 WONT ECHO —— 自己提议自己拒绝，真实 Telnet 服务器协商失败 | 🔴 高 |
| D4 | 末尾 IAC 无缓冲 | line 37 | 没有"残留 IAC 字节留到下一个 chunk 拼接"的机制 | 🟡 中 |

**修复建议**：在 `connectTelnet` 返回的 Transport 对象上维护一个 `iacBuffer`，处理跨 chunk 拼接；修正协商逻辑为收到 DO ECHO 时回 DO（接受自己的提议）。

---

## 三、测试方案（按优先级排序）

### P0 — 阻塞发布（必须修复）

#### 3.1 修复 Telnet IAC 实现 + 补回归测试

**目标**：修复 D1-D4，确保 Telnet 模式在真实设备上可用。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-IAC-01 | IAC 跨 TCP 分片拼接 | 构造两个 chunk：chunk1 = `[0xFF, 0xFB, 0x01]`（WILL ECHO 截断在前两字节 + 第三字节在 chunk2 开头） → 验证不会丢失或乱码 | 输出不含 0xFF |
| T-IAC-02 | SB 子协商跨分片 | 构造 chunk1 = `[IAC, SB, ...]`，chunk2 = `[..., IAC, SE]` + 后续文本 → 验证后续文本完整 | 后续文本完整出现在 onData |
| T-IAC-03 | 协商一致性 | 连接后发 WILL ECHO，模拟服务端回 DO ECHO → 不应再回 WONT ECHO | 发出的响应中不含 `FF FC 01`（WONT ECHO）|
| T-IAC-04 | 正常 Telnet 设备协商全流程 | 用 helpers.ts 起一个会发 WILL ECHO + DO ECHO 的模拟设备 → 验证连接后进入字符模式，输出无 IAC 字节 | onData 输出纯文本 |
| T-IAC-05 | Raw 模式不受影响 | iac=true 的设备 + telnetMode='raw' → IAC 字节原样透传 | 输出含 0xFF |

#### 3.2 B7a 指令通道 HTTP 路由测试

**目标**：覆盖 remotes.ts 的 HTTP handler 主体（当前 39% → 目标 80%+）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-HTTP-01 | OPTIONS 预检 → 204 + CORS 头 | 对 /term-manager/connections.list 发 OPTIONS | 状态 204，含 access-control-allow-* |
| T-HTTP-02 | GET → 405 | 对 /term-manager/connections.list 发 GET | 状态 405 |
| T-HTTP-03 | 非法 JSON → 400 | POST 非 JSON 内容 | 状态 400，返回 bad-request |
| T-HTTP-04 | URL 路径路由 | POST /term-manager/connections.list（body 无 method） | 按 URL 分发到 connections.list |
| T-HTTP-05 | body method 优先 | POST /term-manager/foo（body 含 method=connections.list） | 按 body method 分发 |
| T-HTTP-06 | StoreValidationError → RpcResult 错误分支 | connections.create 缺字段 | 返回 {ok:false, error:{code:含 VALIDATION}} |
| T-HTTP-07 | SessionError → RpcResult 错误分支 | sessions.connect 不存在的 connId | 返回 {ok:false, error:{code:含 SESSION_NOT_FOUND}} |
| T-HTTP-08 | CORS 响应头 | 正常 POST 请求 | 响应含 access-control-allow-origin: * |
| T-HTTP-09 | rpcId 回传 | 发请求带 rpcId | 响应 body 含相同 rpcId |
| T-HTTP-10 | webServer 不可用时降级 | ctx.get('webServer') 返回 undefined | registerRemotes 不调用 register，不报错 |

#### 3.3 B7b 数据流通道生命周期测试

**目标**：覆盖 ws-io.ts 的心跳、订阅清理、异常帧（当前 51% → 目标 80%+）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-WS-01 | 异常 JSON 帧不崩溃 | 发送非法 JSON 字符串 | TermIoConnection 不抛异常，不关闭 |
| T-WS-02 | 未知 kind 帧忽略 | 发送 {kind: 'unknown', sessionId: 'x'} | 无错误，不调用 sessions |
| T-WS-03 | attach 同一会话幂等 | 连续发两次 attach 同一 sessionId | 只注册一次订阅（subscribe 只调一次）|
| T-WS-04 | detach 不存在的会话不报错 | 发 detach 给未 attach 的 sessionId | 无错误 |
| T-WS-05 | input 到不存在的会话静默忽略 | 发 input 给不存在的 sessionId | 无错误，无异常 |
| T-WS-06 | close 后不再推送 | 关闭连接后再触发 onData | 不调用 ws.send |
| T-WS-07 | registerWsIo 无 webServer 降级 | ctx.get('webServer') 返回 undefined | 返回空 disposer，不报错 |
| T-WS-08 | isLoopback 信任栅栏 | 非 loopback 请求 → socket.destroy | host 为 '10.0.0.1' 时 socket 被销毁 |

#### 3.4 入口装配测试

**目标**：覆盖 index.ts（当前 0% → 目标 90%+）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-IDX-01 | apply 调用所有注册函数 | mock ctx + registerTerminalTools + registerRemotes + registerWsIo | 三个函数各被调用一次 |
| T-IDX-02 | 卸载时关闭全部会话 | 调用 ctx.effect 清理函数 | sessions.closeAll 被调用 |
| T-IDX-03 | resolveDataDir 优先级 | 设 DSH_TERMINAL_MANAGER_DATA / DSH_HOME / 都不设 | 分别返回对应路径 |
| T-IDX-04 | 插件元数据 | 检查 export name 和 inject | name='terminal-manager'，inject 含 tools/systemPrompt/webServer |

---

### P1 — 提升可信度（发布前完成）

#### 3.5 B6 工具层边界测试

**目标**：覆盖 tools.ts 的错误分支（当前 66%/54% → 目标 80%/70%）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-TOOL-01 | tm_connect 临时连接缺 host | 调用 tm_connect({protocol:'telnet'}) | 返回 isError=true |
| T-TOOL-02 | tm_send 会话不存在 | 调用 tm_send({sessionId:'fake', command:'x'}) | 返回 isError=true |
| T-TOOL-03 | tm_send 超时 | tm_send + 不喂数据 + timeoutMs:500 | 返回 waitReason='timeout' |
| T-TOOL-04 | tm_send 掉线 | tm_send + 模拟 onClose | 返回 isError=true，含 DISCONNECTED |
| T-TOOL-05 | tm_send_all 空 sessionIds | 不传 sessionIds → 广播到全部 | 全部打开的会话都收到 |
| T-TOOL-06 | tm_send_all 全 busy | 所有目标都在执行中 | 全部返回 outcome='busy' |
| T-TOOL-07 | tm_read 会话不存在 | 调用 tm_read({sessionId:'fake'}) | 返回 isError=true |
| T-TOOL-08 | tm_disconnect 已断开的会话 | 断开后再次 disconnect | 返回 isError=true |
| T-TOOL-09 | tm_connect 重复连接返回既有 | 连两次同一 connId | 第二次返回同一 sessionId |
| T-TOOL-10 | 工具返回格式一致 | 所有 6 个工具 | isError=false 时 value 含预期字段 |

#### 3.6 B2 SSH 传输错误路径补测

**目标**：覆盖 ssh.ts 的未覆盖分支（当前 62% → 目标 75%+）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-SSH-01 | 连接超时 | 起一个不握手的 TCP 服务器 + connectTimeoutMs:500 | 抛 CONN_TIMEOUT |
| T-SSH-02 | shell() 失败 | 模拟 SSH 服务器拒绝 shell 通道 | 抛 TransportError |
| T-SSH-03 | resize 已关闭的连接 | 关闭后调 resize | 不抛异常（静默忽略）|
| T-SSH-04 | write 已关闭的连接 | 关闭后调 write | 不抛异常（静默忽略）|
| T-SSH-05 | close 幂等 | 连续调两次 close | 第二次无错误 |

#### 3.7 B3 Telnet 传输补测

**目标**：覆盖 telnet.ts 的未覆盖行（当前 78%/59% → 目标 85%/70%）。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-TN-01 | 连接错误（error 事件）| 连接到一个立即关闭的端口 | 抛 HOST_UNREACHABLE |
| T-TN-02 | 运行时 socket error | 连接后模拟 socket error 事件 | 触发 onClose，reason 含错误码 |
| T-TN-03 | write 已关闭的连接 | close 后调 write | 不抛异常（静默忽略）|
| T-TN-04 | 对端关闭 → onClose | 服务端主动关闭连接 | onClose 被调用 |
| T-TN-05 | close 幂等 | 连续调两次 close | 第二次无错误 |

---

### P2 — 前端测试（迭代完善）

#### 3.8 客户端 ws.ts（F5 WS 客户端）

**目标**：TermWs 纯 TS 类，无需 DOM，可直接测。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-WS-C01 | open → connecting → open | 注入假 WebSocket，触发 onopen | getStatus() 依次返回 connecting, open |
| T-WS-C02 | 断线 → 自动重连 | 触发 onclose → 等待重连定时器 → 触发 onopen | 重连后重新 attach 所有会话 |
| T-WS-C03 | 指数退避上限 | 连续断线多次 | 重连间隔不超过 10s |
| T-WS-C04 | dispose 停止重连 | 调 dispose 后触发 onclose | 不再调度重连 |
| T-WS-C05 | onOutput 发 attach 帧 | 订阅某会话输出 | ws.send 收到 {kind:'attach', sessionId} |
| T-WS-C06 | input 发 input 帧 | 调 input(sid, data) | ws.send 收到 {kind:'input', sessionId, data} |
| T-WS-C07 | resize 发 resize 帧 | 调 resize(sid, cols, rows) | ws.send 收到 {kind:'resize', ...} |
| T-WS-C08 | 取消订阅发 detach 帧 | 调 onOutput 返回的取消函数 | ws.send 收到 {kind:'detach'} |
| T-WS-C09 | output 帧分发到正确 handler | 收到 {kind:'output', sessionId:'a', data:'x'} | 只有 handler('a') 被调用 |
| T-WS-C10 | status 帧分发到 statusHandler | 收到 {kind:'status', ...} | statusHandler 被调用 |
| T-WS-C11 | 非法 JSON 帧不崩溃 | 收到 'not-json' | 无错误 |
| T-WS-C12 | 连接未 open 时 send 缓冲 | status=closed 时调 input | 不抛异常，帧不发（也不丢 attached 记录）|

#### 3.9 客户端 store.ts（F6 状态同步）

**目标**：store 是模块级 observable，可脱离 React 测核心逻辑。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-STORE-01 | setWorkspaceVisible(true/false) 触发监听 | 注册 listener → toggle | listener 被调用 |
| T-STORE-02 | toggleWorkspace 切换 | 连续调两次 | visible 回到原值 |
| T-STORE-03 | setChatWidth 范围裁剪 | setChatWidth(100) / setChatWidth(9999) | 实际值被夹到 [300, 760] |
| T-STORE-04 | markUnread / markRead | 标记 → 检查 Set → 取消 → 检查 Set | Set 正确增减 |
| T-STORE-05 | markUnread 幂等 | 连续 markUnread 同一 sessionId | Set 大小不变 |

#### 3.10 客户端 rpc.ts（通道①客户端）

**目标**：rpc 函数是纯 fetch 封装，mock fetch 即可测。

| 用例编号 | 测试内容 | 方法 | 通过条件 |
|---|---|---|---|
| T-RPC-01 | 正常调用 | mock fetch 返回 {ok:true, result:{ok:true, value:'x'}} | 返回 'x' |
| T-RPC-02 | 后端错误 | mock fetch 返回 {result:{ok:false, error:{code:'E', message:'m'}}} | 抛 RpcError，code='E' |
| T-RPC-03 | HTTP 错误 | mock fetch 返回 ok=false | 抛 RpcError，code='HTTP_xxx' |
| T-RPC-04 | 请求格式 | 调 rpc('sessions.list') | fetch 被调用，body 含 type/rpcId/method |

---

## 四、覆盖率目标

| 阶段 | 语句 | 分支 | 函数 | 行 | 对应工作 |
|---|---|---|---|---|---|
| 当前基线 | 73 | 64 | 75 | 76 | — |
| P0 完成后 | 80 | 70 | 82 | 82 | 修 Telnet bug + 补 remotes/ws-io/index 测试 |
| P1 完成后 | 85 | 75 | 88 | 87 | 补 tools/ssh/telnet 边界 |
| P2 完成后 | 88 | 78 | 90 | 90 | 前端 ws/store/rpc 测试 |

**vitest.config.ts 门槛同步上调**：每阶段完成后更新 thresholds，让 CI 守住底线。

---

## 五、执行计划

| 阶段 | 工作内容 | 预计用例增量 | 预计耗时 |
|---|---|---|---|
| **P0-a** | 修 Telnet IAC 实现（D1-D4）+ 5 条回归 | +5 | 2-3h |
| **P0-b** | 补 remotes.ts HTTP 路由测试（T-HTTP-01~10） | +10 | 1-2h |
| **P0-c** | 补 ws-io.ts 生命周期测试（T-WS-01~08） | +8 | 1h |
| **P0-d** | 补 index.ts 装配测试（T-IDX-01~04） | +4 | 0.5h |
| **P1-a** | 补 tools.ts 边界（T-TOOL-01~10） | +10 | 1.5h |
| **P1-b** | 补 SSH/Telnet 传输边界（T-SSH-01~05 + T-TN-01~05） | +10 | 1.5h |
| **P2-a** | 客户端 ws.ts 测试（T-WS-C01~12） | +12 | 2h |
| **P2-b** | 客户端 store.ts 测试（T-STORE-01~05） | +5 | 0.5h |
| **P2-c** | 客户端 rpc.ts 测试（T-RPC-01~04） | +4 | 0.5h |
| **合计** | | **+68** | **~12h** |

**建议执行顺序**：P0-a → P0-d → P0-b → P0-c → P1 → P2

理由：先修已知 bug（P0-a），再补最薄弱的模块（P0-d/b/c），再补边界（P1），最后前端（P2）。

---

## 六、测试策略说明

### 6.1 测试金字塔

```
        ┌──────────┐
        │ E2E 冒烟 │  smoke-e2e.mjs（手动 → 后续接入 CI）
       ─┼──────────┼─
      / │ 集成测试  │ \  transport.spec（真 SSH/TCP 设备）
     ───┼──────────┼───
    /   │  单元测试  │ \  其余全部 spec（假传输 / mock ctx / mock ws）
   ━━━━━┿━━━━━━━━━━┿━━━━
```

当前集中在单元层，集成层有 transport 真设备测试，E2E 层有 smoke 脚本但需手起 DSH。

### 6.2 测试原则

1. **模拟设备不碰真设备**：所有测试用 helpers.ts 的 `createDeviceLab`（进程内 TCP/SSH 服务器）
2. **依赖注入**：TransportFactory 可注入假实现（session-manager/tools/remotes/ws-io 测试均已用）
3. **不改测试修代码**：测试失败修代码，不改测试（CLAUDE.md 基线规则）
4. **错误消息不泄露凭据**：所有涉及密码/密钥的测试都断言错误消息不含凭据内容

### 6.3 暂不纳入测试范围

| 项 | 原因 |
|---|---|
| S13 隐藏/显示窗格 | 纯 CSS 交互，需视觉回归工具（非本次范围） |
| S14 多终端聚焦/最大化 | 同上 |
| 组件渲染测试 | 需要 jsdom + @testing-library/react，基础设施待搭建 |
| 真机联调 | 需物理设备，不在自动化范围 |
| evals 24 条场景 | 需 AI agent runner + API 预算，后续专项 |

---

## 七、验收标准

### 发布门禁

- [ ] P0 全部通过（Telnet bug 修复 + HTTP/WS/入口测试补齐）
- [ ] 覆盖率 ≥ 80/70/82/82
- [ ] 84 + 27 = 111 项单测全绿
- [ ] smoke-e2e 19 场景手动跑通一遍（附截图/日志）
- [ ] Telnet 两种模式在模拟设备上各跑 E1-E9 场景通过

### 完整交付门禁

- [ ] P1 全部通过
- [ ] 覆盖率 ≥ 85/75/88/87
- [ ] 111 + 20 = 131 项单测全绿
- [ ] P2 前端 ws/store/rpc 全部通过
