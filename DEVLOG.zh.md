# 开发日志（DEVLOG）

> 写给产品负责人自己看。记录从想法到 MVP 的全过程、踩过的坑、关键决策。

## 2026-08-25：起步

### 想法
在 DeepSeek Harness（DSH）上做一个终端管理插件：
- SSH + Telnet 连接
- 多端口同时操作
- AI 能直接在对话里操作终端（核心价值：解决"AI 碰不到终端"的断层）
- 纯本地，不依赖 MCP

### SDLC 流程
按 AI-native SDLC 跑：意图(intent.md) → 规格(spec.md) → 计划(plan.md) → 里程碑门(M0-M5)。
每个阶段产物提交 git，人工审批后才进下一步。

## 2026-08-25：M0-M1（试探坑 + 方案选型）

### M0 验证：外部插件能进 DSH
最大风险：外部包（不在 harness monorepo 里）的浏览器半能不能被 DSH 装配？
答案：能。双半包结构——host 半(Node ESM) + 浏览器半(惰性 CJS 工厂包)。
关键是 tsdown 的 `deps: { neverBundle, alwaysBundle }`——基线模块走 require，其余打包内联。

### M1 方案定稿
- 架构：公共会话池（不用 DSH 自带 `ctx.terminals`——那是 AI 私有的本机 PTY，做不到人机共用）
- 布局：聊天居中（DSH 原生）+ 右侧工作区（覆盖层），不重画侧边栏和聊天
- 界面选型：B 卡片式 + C 状态中枢混搭，用户做了多轮原型最终定稿 full-view-bc

## 2026-08-26：M2-M3（后端核心 + AI 工具）

### M2 八个后端模块
B1 连接存储 → B2 SSH → B3 Telnet → B4 会话管理器 → B5 完成判定 → B8 命令守卫。
82 项自动化测试，全程用模拟设备（进程内 ssh2 Server + TCP echo），不碰真机。

### M3 AI 工具面 + 指令通道
六个 `tm_*` 工具注册到 `ctx.tools`。AI 调用验证：AI 自主调 tm_connect → tm_send，拿到 MockOS 版本输出。

**关键坑**：`ctx.effect(disposer)` 会立即调用清理函数——把刚注册的路由删了 → 405。
正解：`ctx.effect(() => webServer.register(route))`（register 是 setup，返回的 disposer 才是 cleanup）。

## 2026-08-26：M4（前端 + 全链路打通）

### 前端六大模块
F1 入口(sidebar.footer.action) + F2 连接面板 + F3 终端页 + F4 xterm 终端 + F5 WS 客户端 + F6 状态同步。

### 关键坑（前端）
1. **xterm.css 用 `?raw` 导入** → tsdown 不认，留成 external → "missed the module table"。
   修：用虚拟模块 `tm:xterm-css`（tsdown 插件读文件内联成字符串）。
2. **xterm JS 被 externalize** → 废弃的 `external` 数组导致 bare 包被误判。
   修：改用 `deps: { neverBundle, alwaysBundle }`（对齐官方 clientConfig）。
3. **浏览器 POST application/json 先发 OPTIONS 预检** → 自建路由只接受 POST → 405。
   修：路由处理 OPTIONS（返回 204 + CORS 头）。
4. **布局**：强制 DSH frame 网格成 `sidebar 聊天宽 0px`（详情列压 0 宽，聊天收窄，终端占右侧）。
5. **关闭还原**：capture/restore 放到 `setWorkspaceVisible`（同步），不依赖 React effect 时序。
6. **退格**：模拟设备逐字符处理（多字符 chunk 含退格），用 `\b\x1b[K`（退格+擦到行尾）。
7. **复制粘贴**：Ctrl+C(有选区→复制/无选区→SIGINT) + Ctrl+Shift+C/V + Cmd+C/V + 右键(有选区→复制/无选区→粘贴) + execCommand 降级。
   选中即复制暂时禁用（xterm mouseup 触发 onData 导致同时粘贴，根因待查）。

## 2026-08-26：M5（收尾 + 全面测试）

### 测试四层
| 层 | 覆盖 | 数量 |
|---|---|---|
| vitest 单测 | B1-B8 模块逻辑（假传输） | 82+ |
| 端到端冒烟 | 真 RPC + 真 net.connect（含 SSH） | 19 |
| AI 驱动 | AI 调 tm_* 连模拟设备拿回输出 | 已验 |
| 人工 UI | 连接/敲字/广播/拖动/退格/复制粘贴 | 已验 |

### 覆盖率
src-only：语句 73%、分支 64%、函数 75%、行 76%。
弱项：remotes(39% HTTP 路由)、ws-io(51% WS 升级)——集成胶水，靠冒烟覆盖。
纯逻辑模块 87-100%。

### CI
- `.github/workflows/ci.yml`：每次 push → build + test + coverage(阈值)
- `.github/workflows/smoke.yml`：PR + tag → 起 DSH + 模拟设备 → 跑冒烟 19 场景

### 模拟设备
- `scripts/mock-device.mjs`：Telnet 裸 TCP 路由器 CLI（ANSI 色：提示符绿/横幅青/错误红）
- `scripts/mock-ssh-device.mjs`：SSH 路由器 CLI（密码 admin/test-pass + 密钥认证）

## 关键决策清单

| # | 决策 | 理由 |
|---|---|---|
| 1 | 不用 DSH 自带 `ctx.terminals` | 它是 AI 私有 PTY，做不到人机共用；自建公共会话池 |
| 2 | 双半包打包 | 外部插件必须说宿主语言(TS)；host ESM + 浏览器半 CJS 工厂包 |
| 3 | 指令通道走独立 `/term-manager` 路由 | 不抢 `/api`（api-gateway 已占）；直连 webServer.register |
| 4 | 数据面走 `/term-io` WebSocket | 高频小包双向流，HTTP 不适合 |
| 5 | 完成判定三重：静默500ms/提示符/超时30s | 适配千奇百怪的设备回显 |
| 6 | 命令守卫只拦 AI 路径 | 人的键盘输入字符级没法可靠拦；AI 路径必传 guard |
| 7 | 串口不进 MVP | 传输层接口已留，交付后第一个扩展项 |
| 8 | SSH shell()+PTY | 人和 AI 共用一种交互模式；exec 一次性命令看不到中间输出 |

## 踩坑 Top 10（CLAUDE.md 里有完整版）

1. Windows node 不吃 `/d/...` 路径——用 `D:/...`
2. pnpm 构建豁免写在 `pnpm-workspace.yaml` 的 `allowBuilds:`
3. ssh2 测试服务器必须处理 `session.on('pty', accept)`
4. DSH 没有 `ctx.router`/`ctx.ws`——用 `ctx.webServer.register/registerUpgrade`
5. `ctx.effect(fn)` 的 fn 是 setup、返回值是清理——别把清理函数当 fn 传
6. xterm.css 用虚拟模块内联（不用 `?raw`/`?inline`）
7. `deps.neverBundle/alwaysBundle` 替代废弃的 `external` 数组
8. 浏览器 POST application/json 先发 OPTIONS 预检
9. 退格逐字符处理 + `\b\x1b[K`
10. 复制粘贴的 Ctrl+C 有选区→复制/无选区→SIGINT 二分

## 代码结构

```
terminal-manager/
├── src/                    # 后端（host 半）
│   ├── index.ts            # 装配入口
│   ├── connection-store.ts # B1
│   ├── transport/{types,ssh,telnet}.ts  # B2/B3
│   ├── session-manager.ts  # B4（心脏）
│   ├── wait-policy.ts      # B5
│   ├── command-guard.ts    # B8
│   ├── tools.ts            # B6 AI 工具 ×6
│   ├── remotes.ts          # B7a 指令通道（/term-manager 路由）
│   └── ws-io.ts            # B7b 数据流通道（/term-io WS）
├── client/                 # 前端（浏览器半）
│   ├── index.tsx           # 插槽注册 + 样式注入
│   ├── TerminalWorkspace.tsx  # 覆盖层外壳 + 布局
│   ├── ConnectionsPanel.tsx    # 连接面板
│   ├── TermView.tsx           # xterm.js 终端
│   ├── ws.ts                  # WS 客户端
│   ├── rpc.ts                 # /term-manager RPC 客户端
│   ├── store.ts              # 可见性 + 布局 + 侧边栏宽度
│   └── styles.ts             # CSS（DSH token）
├── tests/                  # 82+ 项 vitest
├── scripts/                # 模拟设备 + 冒烟脚本
├── evals/                  # 24 条 eval + 人工验收清单
├── .github/workflows/      # CI（ci.yml + smoke.yml）
├── docs/solution.zh.md     # 主方案
├── HANDOVER.zh.md          # 交接文档
└── CLAUDE.md               # 仓库记忆（坑 + 命令 + 约定）
```

## 后续（MVP 之后）

- 串口（第一个扩展项，`SerialTransport` 接口已留）
- 递归分屏（v4 的 tmux 式可拖动分屏树，现在是简单网格）
- eval 自动化（24 条接 CI）
- 真机联调（Telnet 协商、SSH 跳板机）
- 凭据加密（接 DSH `ctx.credentials`）
- SSH 主机密钥 TOFU
- OSC 52（远程 vim/tmux 经 SSH 操控本地剪贴板）
- 选中即复制（根因待查：xterm mouseup 触发 onData）
