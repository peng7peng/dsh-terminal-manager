# PR 2 视觉证据（Before / After）

同一场景、同一视口（1280×800）、同一主题（浅色），实际 DSH Web 应用截图，连接本机 mock Telnet 设备（127.0.0.1:2323）。

- **Before**：`main` + 图标兼容修复。DSH 0.2.1 从 `@deepseek-ai/dsh-client-ui-primitives` 移除了这些通用图标；不携带本 PR 的本地图标实现时，`shell.overlay` 会因 React error #130 崩溃（截图无法呈现功能）。为能对比，Before 用同一份图标修复构建（无键盘/探针/页签功能）。
- **After**：本 PR 的功能分支。

| 对比点 | Before | After |
| --- | --- | --- |
| 连接探针圆点 | `before-connections.png`（无圆点） | `after-connections.png`（圆点）/ `after-probe.png`（点击后绿色可达） |
| 终端键盘模式齿轮 | `before-terminal.png`（无齿轮） | `after-terminal.png`（齿轮）/ `after-keyboard.png`（浮层） |
| port-log 页签 | `before-portlog.png`（只有映射） | `after-portlog.png`（端口映射/会话日志/会话共享） |
