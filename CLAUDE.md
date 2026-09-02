# CLAUDE.md — 仓库记忆

本文件保持在一页以内。同一个错误出现两次，就把纠正写进这里。
**新接手的 AI：先读 `CLAUDE.md`（命令/约定/坑）、`spec.md`（唯一设计源）、`plan.md`（进度/待办/偏离记录）。**

## 命令

- 构建：`pnpm build`（tsdown 产出 `lib/index.js` host 半 + `lib/client.js` 浏览器半工厂包）
- 测试：`pnpm test`（vitest；**282 项全绿是基线**，改挂必须修绿再提交）
- 冒烟：`DSH_PORT=4680 node scripts/smoke-e2e.mjs`（19 场景，对活服务）
- 覆盖率：`pnpm vitest run --coverage`（阈值 72/72/60/74，src-only）
- 启动验证：在 `../deepseek-harness` 下 `pnpm dsh --profile tm-dev --port 3180 --no-open`
  - 健康判据：`/plugins/dsh-terminal-manager/client.js` 返回 200；首页 `__DSH_BOOT__` 含 `dsh-terminal-manager` 行
  - **3080 被用户自己的 DSH 占用，别动**；验证一律 3180

## 验证你的工作

报告任务完成前跑 `pnpm build` + `pnpm test` 并粘贴输出。
测试失败修代码，不改测试。测试用 `tests/helpers.ts` 的模拟设备，不碰用户真实设备。

## 约定

- TypeScript strict；React 18 + 全局 `.tm-` 前缀 CSS（无 CSS Modules，无组件库），样式按功能分文件放 `client/styles/`，入口 `index.ts` 拼接。
- 插件是「双半包」：host 半（Cordis 模块）+ 浏览器半（slot 组件），参考 `extensions/ui-cordis`。
- **会话不用 `ctx.terminals`**（那是 AI 私有本机 PTY）；本插件自持 `SessionManager` 公共会话池——人机共用是核心需求。
- 工具注册遵循 `../deepseek-harness/docs/cookbook/adding-a-tool.md`。
- AI 路径的发送必过命令守卫（`guard` 参数）；人的键入不过。错误格式 `{code, message}`，message 永不带凭据。
- 所有文档、提交信息用中文；跟用户说人话（用户懂 C++/Python，不懂 TS）。

## 两人并行开发（2026-09 起：主线 + 扩展模块两条线，不同分支）

- **契约只在 `src/types/`**（`events.ts` 事件总线 / `session-api.ts` 会话公开面 / `file-service.ts` 文件服务），纯声明无实现。**改契约必须单独提 PR 到 main，两人 review**；功能分支不碰这个目录。
- 扩展模块代码放 `src/ext/<模块>/` + `client/ext/<模块>/` + `client/styles/<模块>.ts` + `tests/ext-<模块>.spec.ts`；主线只在 `src/ext/index.ts`、`client/ext/index.tsx`、`client/styles/index.ts` 各留一行挂载。扩展模块只 import `src/types/`，不 import 主线实现。
- `spec.md`/`plan.md` 各改各的章节；`tests/helpers.ts` 只增不改；合 main 前 rebase 一次且测试全绿。

## 架构

host 半：三个门（AI 工具 B6 / 指令通道 B7a / 数据流通道 B7b）汇入 **B4 会话管理器**（状态机 + 1MB 环形缓冲 + 输出分发 + 独占发送 + 广播），B4 唯一接触 **B2 SSH / B3 Telnet** 传输；**B5 完成判定**（静默 500ms / 提示符正则 / 超时 30s，优先级 提示符 > 静默 > 超时）；**B1 连接存储**管配置落盘；**B8 命令守卫**拦 AI 危险命令；**B9 事件总线**（B4 在输出/输入/状态处 emit，扩展模块只 on）。浏览器半经 通道① HTTP / 通道② WebSocket 与后端通信。详见 `spec.md`。

## Agent 容易犯的错

1. **node 在 Windows 不吃 `/d/...` 路径**——脚本里用 `D:/...`；`/tmp` 对 node 不存在。
2. **pnpm 构建豁免写在 `pnpm-workspace.yaml` 的 `allowBuilds:`**（cpu-features/ssh2=false 走纯 JS），写进 package.json 的 pnpm 字段不生效。
3. **写 ssh2 测试服务器必须处理 `session.on('pty', accept)`**，否则客户端 `shell()` 报 "Unable to request a pseudo-terminal"。
4. **DSH 没有 `ctx.router`/`ctx.ws`**——路由用 `ctx.webServer.register/registerUpgrade`（参考 `packages/client/connection/src/index.ts`）。
5. **多会话测试里每个 connect 要独立回调槽位**——共用一个回调变量会被后连的会话覆盖，导致先连的会话收不到数据（测试挂 20 秒超时）。
6. **`ctx.effect(fn)` 的 fn 是 setup、返回值是清理函数**——别把清理函数本身当 fn 传（那会立即执行清理、删掉刚注册的路由，请求 405）。正解：`ctx.effect(() => webServer.register(route))`（register 是 setup，返回的 disposer 才是 cleanup）。
7. **xterm.css / 第三方 CSS 用虚拟模块内联**（`tm:xterm-css` 插件），别用 `?raw`/`?inline`（tsdown 默认不认，会留成 external require → "missed the module table"）。
8. **浏览器 POST `application/json` 会先发 OPTIONS 预检**——自建路由必须处理 OPTIONS（返回 204），否则预检 405 卡住。**但别回 `access-control-allow-origin: *`**：`/term-manager` 有 `files.*` 能读写本机文件，通配 CORS 等于让互联网上任何网页借浏览器打进来（CSRF ≈ 任意文件写）。现有做法：`isTrustedOrigin` 只放行无 Origin / loopback / 与 Host 相同的来源，其余 403；允许的来源原样回显（2026-09-02 审查发现）。
9. **用户数据（连接/收藏等）存后端不存浏览器 localStorage**——localStorage 跟着浏览器走，DSH 重启/换浏览器/清缓存就丢。后端落盘到 `~/.dsh/terminal-manager/connections.json`（`ConnectionConfig` 字段）。向后兼容：旧数据缺字段按"未显式 false = 默认在收藏"处理（`c.favorited !== false`）。
10. **`node_modules/@deepseek-ai/*` 是指向 `../deepseek-harness` 的符号链接**——上游一升级（如 0.1.2-alpha.3 把 `CallId` 改名 `ToolCallId`），这边测试会莫名挂掉；先 `git -C ../deepseek-harness log -3` 看上游动没动，再怀疑自己的改动。

## 钩子（Hooks）

- `hooks/production-gate.sh`：发布门禁，无发布授权时阻止部署动作（exit 2 并说明原因）。
