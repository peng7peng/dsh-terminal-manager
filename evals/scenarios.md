# Eval 场景考题（M5 种子）

- 每条：prompt + 期望结果 + 可机器检查的通过条件。
- 跑法：启动模拟设备 `node scripts/mock-device.mjs 2323` / `2324`，DSH profile tm-dev，用 `claude -p` 或 agent SDK 非交互驱动 AI 调 `tm_*`，断言工具返回/会话状态。
- 这些是 Test 阶段的种子；CI 自动化是后续项（需 agent runner + API 预算）。

## 前置：模拟设备 + 基线

- 设备 A：`127.0.0.1:2323`（telnet，Mock Router，`show version` → `MockOS Version 1.0.4`）
- 设备 B：`127.0.0.1:2324`（同上，端口 2324）
- 所有 eval 前确保无残留会话（`tm_list` 返回空或已知集）。

---

## 组一：配置管理

### E1 新建连接（临时，不入库）
- **Prompt**：调 `tm_connect {protocol:'telnet', host:'127.0.0.1', port:2323, label:'e1'}`
- **期望**：返回 status='open'，banner 含 'Mock Router'。
- **通过**：返回值 `status==='open'` 且 `banner` 含 `'Mock Router'`。

### E2 保存连接 + 按 connId 连
- **Prompt**：`connections.create {label:'e2', protocol:'telnet', host:'127.0.0.1', port:2323}` → 拿 id → `sessions.connect {connId:id}`
- **期望**：连上，status open。
- **通过**：connect 返回 `status==='open'`。

### E3 编辑连接
- **Prompt**：`connections.update {id, patch:{label:'e2-renamed'}}` → `connections.list`
- **期望**：list 含 label='e2-renamed'。
- **通过**：list 中该 id 的 label === 'e2-renamed'。

### E4 删除连接
- **Prompt**：`connections.remove {id}` → `connections.list`
- **期望**：list 不再含该 id。
- **通过**：list 不含该 id。

### E5 校验：SSH 缺认证
- **Prompt**：`connections.create {label:'bad', protocol:'ssh', host:'127.0.0.1', port:22}`（无 username/auth）
- **期望**：返回 VALIDATION 错误。
- **通过**：错误码含 `VALIDATION`。

---

## 组二：连接与观察

### E6 一键连接 + 横幅
- **Prompt**：`tm_connect {protocol:'telnet', host:'127.0.0.1', port:2323}`
- **期望**：banner 含横幅。
- **通过**：返回 banner 含 'Mock Router :2323'。

### E7 多设备同屏
- **Prompt**：连 2323 + 2324 → `tm_list`
- **期望**：list 有 2 个 open 会话。
- **通过**：`tm_list` 返回 2 条 status='open'。

### E8 读现场
- **Prompt**：连上后 `tm_read {sessionId}`
- **期望**：text 含横幅 + 提示符。
- **通过**：text 含 'Mock Router' 且含 'router>'。

---

## 组三：手动操作

### E9 单机发命令
- **Prompt**：连上 → `tm_send {sessionId, command:'show version'}`
- **期望**：output 含版本。
- **通过**：output 含 'MockOS Version 1.0.4'，waitReason 为 quiet/timeout（非错误）。

### E10 广播到全部
- **Prompt**：连 2323+2324 → `tm_send_all {command:'show version'}`
- **期望**：2 条结果，都 ok，都含版本。
- **通过**：返回数组 length=2，每条 outcome='ok' 且 output 含 'MockOS'。

### E11 广播到部分
- **Prompt**：连 2 台 → `tm_send_all {command:'show version', sessionIds:'<只传第一台>'}`
- **期望**：只 1 条结果。
- **通过**：返回数组 length=1。

### E12 广播部分失败（忙碌）
- **Prompt**：连 2 台，对第一台发一条挂起的 `tm_send`(wait=immediate 或长命令占住)，再 `tm_send_all` 到两台
- **期望**：第一台 busy，第二台 ok。
- **通过**：返回数组含一条 outcome='busy'、一条 'ok'。

### E13 独占发送
- **Prompt**：对同一会话并发两条 `tm_send`
- **期望**：第二条返回 SESSION_BUSY。
- **通过**：第二条错误码含 `SESSION_BUSY`。

### E14 发完即回
- **Prompt**：`tm_send {sessionId, command:'show version', wait:'immediate'}`
- **期望**：返回 kind='submitted'。
- **通过**：返回 `kind==='submitted'`；随后 `tm_read` 含版本。

---

## 组四：AI 自动化

### E15 AI 单机测试
- **Prompt**（给 AI）：连上 127.0.0.1:2323 跑 show version 告诉我结果
- **期望**：AI 调 tm_connect + tm_send，汇报版本。
- **通过**：AI 最终回复含 'MockOS' 与 '1.0.4'。

### E16 AI 批量测试
- **Prompt**（给 AI）：连上 127.0.0.1:2323 和 2324，都跑 show version，汇总
- **期望**：AI 广播或逐台发，汇报两台版本。
- **通过**：AI 回复含两台端口（2323、2324）的版本信息。

### E17 AI 读现场
- **Prompt**（给 AI）：连上 2323，告诉我当前屏幕显示什么
- **期望**：AI 调 tm_read，描述横幅。
- **通过**：AI 回复含 'Mock Router'。

### E18 命令守卫拦截
- **Prompt**：连上后 `tm_send {sessionId, command:'rm -rf /'}`
- **期望**：返回 COMMAND_BLOCKED，不写入设备。
- **通过**：错误码含 `COMMAND_BLOCKED`；设备端无该命令回显（tm_read 不含 'rm -rf'）。

### E19 命令守卫白名单豁免
- **Prompt**：连接配置加 guardWhitelist `['^reboot$']` → `tm_send {command:'reboot'}`
- **期望**：放行（不拦截）。
- **通过**：不返回 COMMAND_BLOCKED（命令到达设备，设备回 unknown 或 reboot 响应）。

---

## 组五：异常

### E20 地址不通
- **Prompt**：`tm_connect {protocol:'telnet', host:'127.0.0.1', port:9999}`
- **期望**：HOST_UNREACHABLE 或 CONN_TIMEOUT。
- **通过**：错误码含 `HOST_UNREACHABLE` 或 `CONN_TIMEOUT`。

### E21 断开后操作
- **Prompt**：连上 → 断开（设备关或 tm_disconnect）→ `tm_send {sessionId, command:'x'}`
- **期望**：DISCONNECTED 或 SESSION_NOT_FOUND。
- **通过**：错误码含 `DISCONNECTED` 或 `SESSION_NOT_FOUND`。

### E22 设备掉线 → 状态更新
- **Prompt**：连上 → 杀掉模拟设备进程 → 观察 `tm_list`
- **期望**：会话变 closed 并从 list 移除。
- **通过**：`tm_list` 不再含该 sessionId（或 status=closed）。

### E23 超时复查
- **Prompt**：`tm_send {sessionId, command:'sleep 999', timeoutMs:1000}` → `tm_read`
- **期望**：tm_send waitReason='timeout'；tm_read 含已敲入的 'sleep 999'。
- **通过**：waitReason==='timeout' 且 tm_read text 含 'sleep 999'。

---

## 组六：断线重连（WS）

### E24 WS 重连后重新附着
- **Prompt**：连上 + 终端工作区打开 → 断开浏览器 WS（模拟网络抖动）→ 观察
- **期望**：TermWs 自动重连，重新 attach 所有可见会话，终端继续收输出。
- **通过**：重连后 `tm_send` 仍能拿到输出；终端不丢历史（环形缓冲回放）。

---

## 覆盖映射

| 场景 | eval |
|---|---|
| S1 新建 | E1,E2 |
| S12 编辑/删除 | E3,E4,E5 |
| S2 一键连接 | E6 |
| S3 多设备 | E7 |
| S13 隐藏/显示 | （UI 交互，人工验） |
| S14 多终端聚焦 | （UI 交互，人工验） |
| S4 手动敲 | E9 |
| S5 广播全部 | E10 |
| S6 广播部分 | E11 |
| S7 AI 单机 | E15 |
| S8 AI 批量 | E16 |
| S9 AI 读现场 | E8,E17 |
| S10 人机共视 | （人工验） |
| S11 异常 | E18,E19,E20,E21,E22,E23,E13 |
| 重连 | E24 |
