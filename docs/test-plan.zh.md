# 终端管理插件 — 测试验收清单

这份文档给你（项目负责人）用。你拿它做三件事：
1. **把 Bug 修复指令复制给 AI**，让它改代码
2. **把测试补全指令复制给 AI**，让它补测试
3. **最后手工验收**最关键的用户场景

你不需要写代码，不需要看懂 React，不需要管覆盖率百分比。

---

## 你现在可以敲的命令

```bash
# 跑全部单元测试（84 项，约 3 秒）
cd /d/myProject/dsh/terminal-manager
pnpm test

# 带覆盖率的版本（看哪些文件没测到）
pnpm vitest run --coverage
```

**通过标准**：`pnpm test` 输出 `84 passed (84)`，没有红色报错。

---

## 第一块：已知 Bug 修复清单（复制给 AI）

先让 AI 把已知问题修掉，再做后面的事。

---

### Telnet 模式连真实设备会出现乱码/丢字

**现象**：用 Telnet 模式（不是 Raw 模式）连真实网络设备，终端输出偶尔出现乱码、丢字节、或者命令回显不完整。

**原因**：Telnet 的 IAC 协商代码在处理 TCP 分片时有 bug —— 如果一个协商序列被拆到两个 TCP 包里，代码会丢字节。另外协商逻辑自相矛盾（自己提出 WILL ECHO，服务端接受后又拒绝）。

**影响**：Telnet 模式的设备（非 Raw 模式的）在高延迟/大输出场景下基本不可用。

**复制给 AI**：

> 修复 src/transport/telnet.ts 的 Telnet IAC 协商实现，有三个问题：
>
> 1. stripIac 函数在 chunk 末尾遇到 IAC（0xFF）时直接 break 丢掉，不会缓冲到下一个 chunk 拼接。需要在 connectTelnet 返回的 Transport 对象上维护一个 iacBuffer（Buffer），每次 data 事件把新 chunk 拼到 iacBuffer 后面再处理，处理完保留末尾未完成的 IAC 序列到下次的 chunk。
>
> 2. SB 子协商（IAC SB ... IAC SE）如果横跨两个 chunk，同样会丢数据。修复方法同上 —— 用 iacBuffer 跨 chunk 拼接。
>
> 3. 连接时发了 IAC WILL ECHO + IAC WILL SUPPRESS_GO_AHEAD（line 85），但服务端回 DO ECHO 时（line 40-43），代码却回 WONT ECHO，等于自己拒绝自己的提议。正确做法：收到 DO XXX 时，如果是我们之前 WILL 过的选项，应该不再回复（已经同意了），或者直接忽略。简化方案：对 DO ECHO 和 DO SUPPRESS_GO_AHEAD 不回复。
>
> 修完后在 tests/transport.spec.ts 补 3 条测试：
> - IAC 序列跨两个 chunk 能正确拼接
> - SB 子协商跨两个 chunk 不丢数据
> - 模拟真实 Telnet 设备（发 WILL ECHO → 等 DO → 不再回 WONT）
>
> 修完后跑 pnpm test 确认全绿。

---

## 第二块：单元测试补全清单（复制给 AI）

每个模块的测试指令独立，按顺序逐个复制给 AI。每做完一个跑 `pnpm test` 确认全绿再做下一个。

---

### 插件入口装配测试（当前零覆盖）

**问题**：整个插件的入口文件负责把所有模块组装起来。现在完全没有测试 —— 万一装配逻辑改错了（比如漏注册了一个模块），没有任何测试能发现。

**复制给 AI**：

> 给 src/index.ts 补单元测试，放在 tests/index.spec.ts。
>
> 测试内容：
> - 调 apply(ctx) 后，registerTerminalTools / registerRemotes / registerWsIo 都被调用了
> - 调 apply(ctx) 后模拟卸载（调 ctx.effect 注册的清理函数），sessions.closeAll 被调用
> - resolveDataDir 函数：设 DSH_TERMINAL_MANAGER_DATA 环境变量时用它，否则用 DSH_HOME，再否则用 ~/.dsh/terminal-manager
> - 插件的 export name 是 'terminal-manager'，inject 包含 tools/systemPrompt/webServer
>
> 用 vi.mock 或 vi.spyOn 来跟踪函数调用。跑 pnpm test 确认全绿。

---

### HTTP 路由层测试（当前覆盖不足）

**问题**：处理前端 POST 请求的 HTTP 路由 handler 大部分没测。CORS 预检（OPTIONS 返回 204）、非法 JSON（返回 400）、GET 请求（返回 405）这些边界路径都是黑的。

**复制给 AI**：

> 给 src/remotes.ts 的 registerRemotes 函数补 HTTP 路由测试，放在 tests/remotes-http.spec.ts。
>
> 不需要真的起 HTTP 服务器，直接构造假 req/res 对象测 handler 函数。可以修改 remotes.ts 把 handler 函数单独 export 出来便于测试。
>
> 测试内容：
> - OPTIONS 请求 → 响应 204，含 access-control-allow-origin/methods/headers 头
> - GET 请求 → 响应 405
> - POST 非 JSON 内容 → 响应 400，body 含 bad-request
> - POST 正常请求 → 响应 200，body 含 rpcId 和 result
> - 连接存储校验失败 → result.ok=false，error.message 含 VALIDATION
> - 会话不存在 → result.ok=false，error.message 含 SESSION_NOT_FOUND
> - 响应含 access-control-allow-origin: * 头
>
> 跑 pnpm test 确认全绿。

---

### WebSocket 数据流通道的生命周期测试

**问题**：心跳探活、异常帧处理、多连接订阅互不干扰等逻辑没测到。

**复制给 AI**：

> 给 src/ws-io.ts 补生命周期测试，追加到 tests/ws-io.spec.ts。
>
> 测试内容（用现有的 fakeWs 假 WebSocket）：
> - 发非法 JSON 字符串 → 不崩溃，不关闭连接
> - 发未知 kind 的帧（比如 {kind:'unknown'}）→ 静默忽略
> - 同一会话连续发两次 attach → subscribe 只被调一次（幂等）
> - detach 未 attach 的会话 → 不报错
> - 给不存在的会话发 input → 不报错
> - 连接关闭后，会话输出不再推给该连接
> - registerWsIo 在 ctx.get('webServer') 返回 undefined 时不报错，返回空 disposer
>
> 跑 pnpm test 确认全绿。

---

### AI 工具层的错误路径

**问题**：AI 工具的正常流程测了，但各种错误情况（会话不存在、超时、掉线、空参数）没测。

**复制给 AI**：

> 给 src/tools.ts 补错误路径测试，追加到 tests/tools.spec.ts。
>
> 测试内容：
> - tm_connect 临时连接缺 host → 返回 isError
> - tm_send 传不存在的 sessionId → 返回 isError
> - tm_send 传空 command → 返回 isError
> - tm_read 传不存在的 sessionId → 返回 isError
> - tm_disconnect 传不存在的 sessionId → 返回 isError
> - tm_send 超时（wait 参数 timeoutMs 很短，不喂数据）→ 返回 waitReason='timeout'
> - tm_send 过程中会话掉线 → 返回 isError
> - tm_connect 重复连同一个 connId → 返回同一个 sessionId
>
> 跑 pnpm test 确认全绿。

---

### SSH 传输层的错误路径

**问题**：SSH 连接正常流程测了，但超时、连接已关闭后操作、close 幂等性等没测。

**复制给 AI**：

> 给 src/transport/ssh.ts 补错误路径测试，追加到 tests/transport.spec.ts。
>
> 测试内容：
> - 连接超时：起一个只监听不握手的 TCP 服务器，设 connectTimeoutMs:500，抛 CONN_TIMEOUT
> - close 后调 write → 不抛异常（静默忽略）
> - close 后调 resize → 不抛异常
> - close 连续调两次 → 第二次不报错（幂等）
>
> 用 helpers.ts 的 createDeviceLab 或自己起 TCP 服务器。跑 pnpm test 确认全绿。

---

### Telnet 传输层的边界

**问题**：Telnet 正常收发测了，但连接错误、运行时 socket error、对端关闭等路径没测。

**复制给 AI**：

> 给 src/transport/telnet.ts 补边界测试，追加到 tests/transport.spec.ts。
>
> 测试内容：
> - 连接到一个立即关闭的端口 → 抛 HOST_UNREACHABLE
> - 连接后模拟 socket error 事件 → 触发 onClose，reason 含错误信息
> - close 后调 write → 不抛异常（静默忽略）
> - 服务端主动关闭连接 → onClose 被调用
> - close 连续调两次 → 第二次不报错
>
> 跑 pnpm test 确认全绿。

---

### 客户端 WebSocket 客户端测试（纯 TS，不涉及 React）

**问题**：前端的 WebSocket 客户端是纯 TS 类（不依赖 React），可以像后端一样测试，但目前完全没覆盖。

**复制给 AI**：

> 给 client/ws.ts 的 TermWs 类补单元测试，放在 tests/client-ws.spec.ts。
>
> TermWs 是纯 TS 类，用 webSocketCtor 参数注入假 WebSocket 构造器即可测试，不需要 jsdom。
>
> 测试内容：
> - open() 后状态变成 connecting，假 WebSocket onopen 触发后变成 open
> - 假 WebSocket onclose 触发后 → 自动重连（setTimeout 被调度）
> - dispose() 后不再重连
> - onOutput 订阅 → 假 WebSocket send 收到 attach 帧
> - 取消订阅 → send 收到 detach 帧
> - input() → send 收到 input 帧
> - resize() → send 收到 resize 帧
> - 收到 output 帧 → 对应 handler 被调用
> - 收到 status 帧 → statusHandler 被调用
> - 收到非法 JSON → 不崩溃
> - 连接未 open 时调 input → 不抛异常
>
> 跑 pnpm test 确认全绿。

---

### 客户端状态 store 测试（纯逻辑，不涉及 React）

**问题**：前端的状态 store（工作区可见性、聊天宽度、未读标记）是纯逻辑模块，可以脱离 React 测。

**复制给 AI**：

> 给 client/store.ts 补单元测试，放在 tests/client-store.spec.ts。
>
> 这个模块是模块级 observable（单例），测试时注意在 beforeEach 里重置状态。
>
> 测试内容：
> - setWorkspaceVisible(true) 后 listener 被调用
> - toggleWorkspace 连续调两次 → 状态回到原值
> - setChatWidth(100) → 实际值被夹到 300（最小值）
> - setChatWidth(9999) → 实际值被夹到 760（最大值）
> - markUnread(sid) → 未读集合包含 sid
> - markRead(sid) → 未读集合不含 sid
> - markUnread 连续调两次同一 sid → 集合大小不变（幂等）
>
> 跑 pnpm test 确认全绿。

---

### 客户端 RPC 函数测试（纯 fetch 封装）

**问题**：前端的 RPC 调用函数是 fetch 封装，mock 掉全局 fetch 就能测。

**复制给 AI**：

> 给 client/rpc.ts 补单元测试，放在 tests/client-rpc.spec.ts。
>
> 用 vi.stubGlobal('fetch', ...) mock 掉 fetch。
>
> 测试内容：
> - 正常调用 → 返回 result.value
> - 后端返回 ok:false → 抛 RpcError，error.code 正确
> - fetch 返回 HTTP 错误（ok=false）→ 抛 RpcError，code 含 HTTP_ 前缀
> - 调用时 fetch 的参数正确（URL、method、headers、body 含 type/rpcId/method）
>
> 跑 pnpm test 确认全绿。

---

## 第三块：手工验收清单（最后做）

等 Bug 修完、测试补完、全绿之后，再做手工验收。

前置：先起模拟设备和 DSH。

```bash
# 终端 1：起模拟设备 A
node scripts/mock-device.mjs 2323

# 终端 2：起模拟设备 B
node scripts/mock-device.mjs 2324

# 终端 3：起 DSH
cd ../deepseek-harness
pnpm dsh --profile tm-dev --port 3180 --no-open

# 浏览器打开 http://127.0.0.1:3180
```

然后点侧边栏底部的「🖥️ 终端管理」按钮，按下面 10 个场景逐个验。

---

### 新建一个 Telnet 连接

**操作**：切到「连接」页签 → 协议选 Telnet → 名称填 `测试A`，地址 `127.0.0.1`，端口 `2323` → 点保存

**通过**：连接卡片列表出现「测试A」

---

### 点连接 → 看到终端输出

**操作**：点「测试A」卡片上的连接按钮

**通过**：终端页签出现窗格，显示 `Mock Router` 横幅，状态条芯片变绿

---

### 手动敲命令

**操作**：点终端窗格 → 键盘输入 `show version`，回车

**通过**：终端回显命令和 `MockOS Version 1.0.4`

---

### 连第二台设备 → 多终端同屏

**操作**：回连接页签 → 新建 `测试B`（端口 2324）→ 点连接

**通过**：两个终端窗格各自独立显示，互不串扰

---

### 广播一条命令到两台

**操作**：终端页签 → 底部广播栏输入 `show version` → 点发送

**通过**：两个终端都回显版本号

---

### 隐藏一个终端（不断开）

**操作**：点状态条上「测试A」的芯片

**通过**：终端窗格消失，芯片变暗但名字还在；再点一次恢复

---

### 删除连接

**操作**：回连接页签 → 点「测试A」的 ✕

**通过**：卡片消失，对应终端窗格也消失

---

### 连不存在的地址 → 报错

**操作**：新建连接 `不通的`（端口 9999）→ 点连接

**通过**：弹出错误，含 `HOST_UNREACHABLE` 或 `CONN_TIMEOUT`，不会卡死

---

### SSH 密码错 → 报错且错误不含密码

**操作**：先 `node scripts/mock-ssh-device.mjs 2222` → 新建 SSH 连接（端口 2222，密码 `wrong`）→ 点连接

**通过**：弹出 `AUTH_FAILED`，错误信息里不出现密码明文

---

### AI 调工具 → 你实时看见

**操作**：确保有一个已连接会话 → 在聊天窗口对 AI 说「连上 127.0.0.1:2323 跑一下 show version」

**通过**：终端窗格实时显示 AI 的操作过程，AI 最终回复版本信息

---

### 验收完打勾记录

| 场景 | 结果 |
|---|---|
| 新建连接 | ☐ 通过 / ☐ 失败（备注：） |
| 一键连接 | ☐ 通过 / ☐ 失败 |
| 手动敲命令 | ☐ 通过 / ☐ 失败 |
| 多终端同屏 | ☐ 通过 / ☐ 失败 |
| 广播 | ☐ 通过 / ☐ 失败 |
| 隐藏/显示 | ☐ 通过 / ☐ 失败 |
| 删除连接 | ☐ 通过 / ☐ 失败 |
| 地址不通 | ☐ 通过 / ☐ 失败 |
| SSH 密码错 | ☐ 通过 / ☐ 失败 |
| AI 调工具 | ☐ 通过 / ☐ 失败 |

---

## 执行顺序

按这个顺序来，每步做完跑 `pnpm test` 确认全绿：

| 顺序 | 做什么 | 谁做 |
|---|---|---|
| 1 | 修 Telnet IAC 的 Bug | 给 AI |
| 2 | 补入口装配测试 | 给 AI |
| 3 | 补 HTTP 路由层测试 | 给 AI |
| 4 | 补 WS 生命周期测试 | 给 AI |
| 5 | 补工具层错误路径测试 | 给 AI |
| 6 | 补 SSH 错误路径测试 | 给 AI |
| 7 | 补 Telnet 边界测试 | 给 AI |
| 8 | 补客户端 ws.ts 测试 | 给 AI |
| 9 | 补客户端 store.ts 测试 | 给 AI |
| 10 | 补客户端 rpc.ts 测试 | 给 AI |
| 11 | 手工验收 10 个场景 | 你自己点 |

每做完一步对 AI 说「跑 pnpm test，贴结果给我看」，全绿再继续。

---

## 明确不需要做的事

以下这些**不要做**，避免浪费时间：

- **前端 React 组件渲染测试**（ConnectionsPanel / TermView / TerminalWorkspace）—— 需要 jsdom + @testing-library/react，基础设施搭建成本高，且 UI 交互用手工验收更靠谱
- **evals 24 条场景自动化** —— 需要 AI agent runner，是另一个专项
- **端到端 smoke-e2e.mjs 接 CI** —— 需要手起 DSH，后续专项处理
- **真机联调** —— 需要物理网络设备
- **跳板机/堡垒机** —— 不在 MVP 范围
- **串口支持** —— 不在 MVP 范围
