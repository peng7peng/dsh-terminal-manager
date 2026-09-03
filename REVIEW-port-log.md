# 端口映射、会话共享与日志扩展评审

- 日期：2026-09-03
- 分支：`feat/sep-port-log`
- 依据：`intent/port-mapping-sharing-log.md`、`spec.md`、`plan.md`、`REVIEW.md`
- 状态：自动评审完成；等待人工 UI 验收和代码负责人审批

## 第一轮：缺陷

已修复的重要发现：

1. 映射原子保存失败时可能残留临时文件；现于 `src/ext/port-log/mapping-store.ts` 的失败路径删除明确临时文件。
2. UDP 目标 `send` 回调错误可能保留失效 peer；现于 `src/ext/port-log/udp-forwarder.ts` 按来源删除并记录安全错误。
3. 单个共享输出块可在写入前绕过 1 MiB 背压限制；现于 `src/ext/port-log/share-manager.ts` 使用“当前缓冲 + 本次输出”判定并仅断开故障客户端。
4. 重复停止同一共享实例原先会返回不存在错误；现保持幂等，并由 `tests/ext-port-log-share.spec.ts` 回归。

复查结果：没有未处理的高/中严重度逻辑发现。TCP/UDP 端口冲突、停止复用、IPv4/IPv6、UDP 来源隔离和空闲回收均使用真实本地 Socket 测试。

## 第二轮：安全

- 控制面只接受 loopback 来源，并拒绝不匹配 Host 的 Origin：`src/ext/port-log/router.ts`。
- 应用日志递归清理敏感键且不记录 RPC 原始载荷：`src/ext/port-log/app-logger.ts`；真实 smoke 使用唯一敏感串扫描全部应用日志文件。
- 会话日志只订阅 `output/status`，没有 `input` 订阅：`src/ext/port-log/session-log-manager.ts`。
- 共享客户端输入只调用冻结的 `SessionManagerApi.write`：`src/ext/port-log/share-manager.ts`。
- 无认证、完全可写是产品明确接受的共享模型；UI 启动按钮受显式风险勾选控制：`client/ext/port-log/SharesTab.tsx`。

复查结果：没有未处理的高/中严重度安全发现。共享服务的固有暴露风险仍需由人工评审确认接受。

## 第三轮：spec/plan 合规

- `git diff origin/main -- src/types` 为空，冻结契约未修改。
- 主线实现文件无 diff；只通过 `src/ext/index.ts`、`client/ext/index.tsx`、`client/styles/index.ts` 三个挂载点接入。
- 新增实现均位于 `src/ext/port-log/`、`client/ext/port-log/` 和 `client/styles/port-log.ts`；测试均使用 `tests/ext-port-log-*`。
- 未新增 Agent 工具；端口操作只通过 GUI/RPC。
- `pnpm build`、`pnpm test`、`pnpm vitest run --coverage` 和 `scripts/ext-port-log-smoke.mjs` 已通过。

未完成证据：本机没有 Python Playwright，应用内浏览器也无可用实例，因而未生成明暗主题和共享风险确认截图。此项保留为人工 UI 验收，不把分支标记为已批准或已发布。
