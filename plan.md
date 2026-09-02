# DSH Terminal Manager — 构建计划

- 派生自：`spec.md`（唯一设计源，已合并原 `docs/solution.zh.md`）
- 状态：MVP M0–M5 已全部完成（2026-08-26）；**九月迭代已开工（2026-09-02，见文末「九月迭代」）**；本文件按 SDLC 规则 6 随实现偏离同步更新
- 日期：2026-08-25
- 修订：
  - 2026-08-25 插入「方案讲解 + GUI 方案选型」里程碑（M1）
  - 2026-08-28 同步真实实现的偏离（见下「实现偏离记录」）；`docs/connections-panel-upgrade.zh.md` 的剩余待办并入本文「后续待办」段，原文件已归档
  - 2026-09-02 追加「九月迭代」计划：契约先行 PR + 主线 S1–S5 + 扩展模块轨道

## 实现偏离记录（规则 6：偏离即同提交更新）

实施中相对原计划的偏离，均在 `spec.md` 体现为真实设计：
1. **控制面**：原计划走 `ctx.typert.remotes` 的 `/api` RPC；实际改为 `ctx.webServer.register` 独立前缀路由 `/term-manager`（绕开 connection.rpc 作用域问题 + `/api` 与 api-gateway 冲突），含 OPTIONS 预检。
2. **GUI**：原计划挂「右侧 details 栏 + 终端/连接双页签」；实际改为 `shell.overlay` 全屏覆盖层工作区，终端模块 + 连接面板左右并排（非页签）。
3. **终端宽度**：原计划未定；实际做了响应式——终端模块目标宽 480、未拖动时聊天填满左侧无留白、拖动上限随视口动态 `max(760, 视口宽-764)`、终端网格 `auto-fit + 1fr` 填满。
4. **Telnet**：原计划裸 TCP 透传；实际加 `telnetMode: 'telnet'|'raw'`，telnet 模式剥离 IAC（Buffer 操作、只剥离不回发）。
5. **连接配置**：新增 `telnetMode`/`handshakeTimeoutSec`/`newline`/`localEcho`/`guardWhitelist`/`timeoutMs` 字段；sendAndWait 用配置的换行。
6. **文件名**：原计划的 `TerminalPanel.tsx`/`ConnectionsTab.tsx`/`TerminalsTab.tsx`/`*.module.css`/`config.ts` 均未采用；实际见下「改动文件（真实）」。

## 改动文件（真实，M0–M5 已落地）

### host 半（`src/`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 入口：装配 ConnectionStore、SessionManager、`tm_*` 工具、`/term-manager` 路由、`/term-io` WS；`ctx.effect` 清理 |
| `src/connection-store.ts` | 连接配置 CRUD + JSON 持久化（0600）+ 校验；含 telnetMode/handshakeTimeoutSec/newline/localEcho 等字段 |
| `src/wait-policy.ts` | 完成判定三重机制（静默期/提示符正则/超时）纯函数状态机 |
| `src/command-guard.ts` | 命令守卫（AI 路径黑名单 + 白名单） |
| `src/transport/types.ts` | 传输层内部接口 |
| `src/transport/ssh.ts` | ssh2 shell 通道；密码/密钥认证；可配握手超时；主机密钥指纹采集（MVP 接受任意） |
| `src/transport/telnet.ts` | `net.connect`；telnet 模式剥离 IAC，raw 透传 |
| `src/session-manager.ts` | 会话状态机、环形缓冲（1MiB）、订阅、独占发送、广播；用配置的换行 |
| `src/tools.ts` | 六个 `tm_*`（defineTool）+ `ctx.systemPrompt.section` |
| `src/remotes.ts` | `/term-manager` HTTP 路由（`createHttpHandler`）；`connections.*` 与 `sessions.*` 控制面 |
| `src/ws-io.ts` | `/term-io` WebSocket upgrade + 帧协议 + 信任栅栏（loopback） |

### 浏览器半（`client/`）

| 文件 | 职责 |
|---|---|
| `client/index.tsx` | `apply(ClientContext)`：locale、`sidebar.footer.action` 入口、插槽挂载、样式注入 |
| `client/TerminalWorkspace.tsx` | 覆盖层外壳 + 布局（`useFrameLayout`）+ 终端网格 + 广播栏（两行） |
| `client/ConnectionsPanel.tsx` | 连接面板：表单 + 收藏 + 最近 + 活跃会话 + 右键菜单 + 拖动排序 |
| `client/TermView.tsx` | xterm.js 封装：WS attach/输入/回放/尺寸自适应/复制粘贴/主题 |
| `client/ws.ts` | `/term-io` 客户端：单连接多路复用、断线重连、帧分发 |
| `client/rpc.ts` | `/term-manager` RPC 客户端（fetch 封装） |
| `client/store.ts` | 可见性 + 聊天宽度（含 `getEffectiveChatWidth` 动态）+ 布局 + 未读 |
| `client/styles.ts` | 全局 `.tm-` 前缀样式（用 DSH `--dsw-*` token，**非 CSS Modules**） |

### 测试与脚本

- `tests/`：167 项 vitest（含 `mock-device.spec.ts` 退格钳制、`remotes-http.spec.ts`、`ws-io` 容错等）。
- `scripts/mock-device.mjs`（Telnet 路由器 CLI，退格钳制）、`scripts/mock-ssh-device.mjs`（SSH 路由器 CLI）、`scripts/smoke-e2e.mjs`（19 场景冒烟）。

## 工作顺序（M0–M5，均已完成）

M0 脚手架与垂直切片 ✅ ｜ M1 方案 + GUI 选型 ✅ ｜ M2 连接核心（B1–B5/B8）✅ ｜ M3 Agent 工具面（B6/B7a）✅ ｜ M4 数据面 + GUI（B7b + F1–F6）✅ ｜ M5 收尾 + 验收 ✅。详细里程碑内容见 git 历史。

## 手工验收发现的 bug（2026-08-28）

手工验收通过，但发现 11 项需修复：

| # | 问题 | 优先级 | 状态 |
|---|---|---|---|
| 1 | 文档措辞：S1 应为「收藏」非「最近连接」 | 低 | ✅ |
| 2 | 临时连接不写入「最近连接」历史记录（断开后应保留） | 中 | ✅ |
| 3 | **终端布局重构**：改成 1/2/3 列可选网格（自动平衡、全局滚动、最小 10 行） | 高 | ✅ |
| 4 | **全屏 bug**：拖动分隔条后退出全屏，终端模块消失无法调出 | 高 | ✅ |
| 5 | 终端窗格加最小化/最大化按钮（现在只有关闭） | 中 | ✅ |
| 6 | 输出错行（MockOS 版本和编译日期之间有空行） | 中 | ✅ |
| 7 | 退格仍能删提示符（之前说已修，没修干净） | 中 | ✅ |
| 8 | AI 连接识别：tm_connect 不查已收藏配置，直接新建 | 中 | ✅ |
| 9 | 侧边栏收缩后布局不补齐（聊天区留空白） | 中 | ✅ |
| 10 | 设备掉线后保留终端窗格（标记已断开，非移除） | 中 | ✅ |
| 11 | 命令守卫没拦截 `rm -rf /`（安全检查） | 高 | ✅ |

## 第二轮验收发现的问题（2026-08-28 下午）

| # | 问题 | 优先级 | 状态 |
|---|---|---|---|
| 12 | 1列时终端窗口没有边框（margin 问题） | 中 | ✅ |
| 13 | 3列时有水平滚动条（应均分宽度） | 中 | ✅ |
| 14 | 按钮顺序改成「最小化、最大化、关闭」 | 低 | ✅ |
| 15 | 危险命令拦截时要弹窗确认（而非静默拦截） | 中 | ⏳ |

## 后续待办（原 `docs/connections-panel-upgrade.zh.md` 剩余项 + 其他）

- **localEcho 接通 xterm**：配置已存后端，终端 onData 回显未接（中等复杂度）。
- **Telnet 自动登录**：账号/密码/提示正则/超时/延迟。
- **会话信息弹窗**：协议/状态/换行/回显/会话 ID。
- **导入/导出** CSV/JSON 连接配置。
- **收藏分组/搜索**。
- **凭据加密**：接 DSH `ctx.credentials`，替明文 JSON。
- **SSH 主机密钥 TOFU**：首次信任 + known-hosts。
- **Serial 串口**：`SerialTransport` 接口已留。
- **递归分屏**：tmux/iTerm2 式可拖动分屏树（现简单网格）。
- **eval 自动化**：`evals/scenarios.md` 24 条接 CI。
- **真机联调**：Telnet 协商、SSH 跳板机。
- **OSC 52**：远程 vim/tmux 经 SSH 操控本地剪贴板。

## 手工验收后续修正（2026-08-30）

| # | 问题 | 优先级 | 状态 |
|---|---|---|---|
| 16 | 收藏状态存浏览器 localStorage，DSH 重启/换浏览器/清缓存后收藏消失 | 高 | ✅ |
| 17 | AI 调工具连接的会话（临时连接）出现在「⭐ 收藏」而非「最近连接」；前端列表不实时刷新 | 高 | ✅ |
| 18 | Telnet 连接真实服务器时，因未主动发送 NAWS 初始窗口大小，服务器等待超时断开 | 高 | ✅ |

**修法**：`ConnectionConfig` 加 `favorited?: boolean` 字段，跟连接配置一起落盘到 `~/.dsh/terminal-manager/connections.json`。前端不再用 localStorage 存收藏 ID 集合，改读 `c.favorited`。向后兼容：旧数据缺字段按"未显式 false = 在收藏"处理（`c.favorited !== false`），无需迁移脚本。新建默认 `favorited: true`。

**#17 修法**：`session-manager.ts` 的 `connect()` 自动创建临时连接时硬编码 `favorited: false`（符合原设计"临时连接也入「最近连接」"的注释）。前端 `ConnectionsPanel` 加 `useEffect`：会话数量增加时自动重拉 connections 列表，解决 AI 工具创建的连接不能实时出现在 UI 的问题。

**#18 修法**：`transport/telnet.ts` 在连接建立时主动发送默认 80x24 NAWS 子协商数据（`sendWindowSize(80, 24)`），不再依赖前端 `ws.resize()` 的异步到达。某些服务器（特别是 Linux/Windows telnetd）在收到客户端 WILL NAWS 后会等子协商数据，超时（约 30–60s）不发就断开连接。前端 ResizeObserver 后续的 resize 仍会更新真实尺寸。

## 九月迭代（2026-09-02 起）

- 设计源：仓库外 `../开发过程文档/` 下的「设计方案」（V0.2）+「交互设计」（定稿），不入库；原型 `prototypes/design-demo.html` 等在库内
- 协作：主线（主线负责人，`feat/sep-workbench`）与扩展模块（扩展模块负责人，日志管理 / 共享端口，自开分支）并行；契约见 `spec.md`「模块间契约」

### S0 契约先行 PR（本 PR，合 main 后两人各自拉分支）

| 项 | 状态 |
|---|---|
| 设计方案 / 交互设计 / 原型入库 | ✅ |
| `src/types/{events,session-api,file-service}.ts` 三个契约文件 | ✅ |
| B9 事件总线实现 + B4 埋点（output / input 含来源 / status） | ✅（tests/event-bus.spec.ts、tests/session-events.spec.ts） |
| 挂载空壳 `src/ext/index.ts` + `client/ext/index.tsx`；`client/styles.ts` 拆成 `client/styles/` 目录 | ✅ |
| `spec.md` 契约章节 + 扩展模块占位章节；`CLAUDE.md` 协作规矩 | ✅ |
| 决策：文件服务由本插件实现、扩展模块负责人复用（原「归属待定」已定） | ✅ |

### 主线里程碑（S1–S5，对应设计方案 M1–M5；约 12 + 8 人天）

| 里程碑 | 内容 | 依赖 | 预估 | 状态（2026-09-02 盘点） |
|---|---|---|---|---|
| **S1 本地文件服务 + UI 骨架** | `FileService` 本地四件套（listLocal/readLocal/writeLocal/listDirectories，路径安全：归一化 + 符号链接解析 + 树根校验）+ `files.*` 端点 + Config `workspaceRoot`；本地文件面板（收起条/展开、面包屑、换目录）；浮动编辑器窗（拖/缩/最大化/最小化成底部标签）+ Tab 管理 | S0 | 4 天 | ✅ 2026-09-02（步骤 1–7） |
| **S2 编辑器** | CodeMirror 6 全量打包（`tm:codemirror-css` 虚拟模块）+ 语法高亮（sh/py/json/md）+ 打开/保存（Ctrl+S 原子写）/ 脏标记 / 关 Tab 保存确认 / >10MB 只读 | S1 | 3 天 | ✅ 2026-09-02（步骤 8；偏离：无需虚拟模块） |
| **S3 选中发送 + TC 执行** | `src/tc-parser.ts`（语法按真实样例，spec B11）；TC 徽章（窗格标题 + 活跃会话项，拖动 = 换编号）；[▶ 执行脚本] + 右键执行选中 / 执行本节 + 映射确认框（"本次会话不再确认"）+ 常驻汇总条；[▶ 发送选中→] 终端多选弹窗 + 逐条 `sessions.send`（source `script`）+ >20 行提示；按钮可用性矩阵（D5） | S2 | 3 天 | ✅ 2026-09-02（步骤 9–12 + 两轮验收修订 R0–R9） |
| **S4 联调收尾** | 接入扩展模块负责人模块联调、eval 场景补齐、README「文件访问范围」、spec/plan 同步 | S3 + 扩展模块 | 2 天 | ⏳ 部分：README/spec/plan 同步已随步骤 12 完成；**模块联调被同事阻塞**（扩展模块需求文档未成稿），等对方就绪 |
| **S5 文件传输 + 远端面板** | `transport/ssh.ts` 导出 `getSftp()`（复用 Client 开 sftp 通道）→ `transport/sftp.ts`；`FileService` 远端四件套；Telnet base64 命令模拟（≤1MB，Config `telnetFileTransfer` 开关，UI 标实验性）；`/files/upload`（POST raw）/ `/files/download`（GET 流式）路由 + `/term-io` `file-progress` 帧；远端文件面板（切终端 chips、6 按钮、同名覆盖/跳过/重命名）；`tm_upload` / `tm_download`；`file` 事件派发 | S1（可与 S3 并行，最后合） | 8 天 | ⬜ 未开工 → **2026-09-02 开工，细化计划见下** |

调整说明（相对设计方案）：本地文件服务和路径安全从 M2 提前到 S1 最前面做——文件面板、编辑器都依赖它，且它是 `FileService` 契约的第一批实现，能尽早验证契约。2026-09-02 下午确认：同事不新增工作区面板，UI 部分不再等对齐会；S1–S3 合在一个分支 `feat/sep-s1-files` 上按下面顺序推进。

### 分支 `feat/sep-s1-files` 细化计划（S1–S3，已完成）

从 `feat/sep-workbench` 切出，契约 PR 合 main 后 rebase 到 main。每步「代码 + 测试」一个提交，`pnpm build` + `pnpm test` 全绿才进下一步；偏离本表即同提交改本文。

**从 better-sidebar 抄什么**（源码 `../DSH-better-sidebar`，MIT；逐文件审阅后裁剪，抄过的文件头注明来源，README 致谢）：

| 我们的文件 | 抄自 | 裁剪 |
|---|---|---|
| `src/path-security.ts` | `src/path-security.ts`（81 行）+ `src/fs-tree.ts` 的 `isWithin/requireAbsolute` | 错误类换成 `FileServiceError`；`isWithin` 已含 win32 大小写不敏感比较，直接用 |
| `src/file-service.ts` 的 `listLocal` | `src/fs-tree.ts`（158 行：目录优先排序、symlink 探测、截断） | 去掉 hidden 标记与流式 opendir，改成返回契约的 `FileEntry` |
| `client/editor/useFloatWindow.ts` | `src/client/FreeWindow.tsx`（337 行）的拖动 / 缩放 / 置顶逻辑 | 去掉「拖回工作台停靠」；只留 move / resize / raise；最大化 / 最小化自写 |
| `client/editor/EditorTabs.tsx` | `src/client/TabBar.tsx` | 去掉拖拽分栏与 split pane；留开 / 关 / 切 / 脏点 |
| `client/editor/CodeEditor.tsx` | `src/client/TextEditor.tsx` + `editor-load.ts` + `cm-themes.ts`（明暗主题跟 DSH token） | 去掉 chunk 懒加载（我们全量打包）；`lang.ts` 225 行只留 shell / python / json / markdown 四种 |
| 不抄 | `FileTree.tsx`（701 行树形，我们是单层列表）、`EditorHost.tsx`（多 pane 宿主）、CSS Modules | 面板列表自写；样式一律 `.tm-` 全局类（不引入 CSS Modules） |
| 图标 | `@deepseek-ai/dsh-client-ui-primitives` 的 SVG 图标（已在宿主模块表，不增体积） | 文件面板 / 编辑器 / 确认框用 DSH 图标替代 emoji，与 DSH 原生观感一致（2026-09-02 用户确认） |

| # | 步骤 | 文件 | 测试 / 证据 |
|---|---|---|---|
| 1 | ✅ Config schema：`workspaceRoot`（默认 `process.cwd()`）、`telnetFileTransfer`（S5 用，先占位）；`apply(ctx, config)` 接第二参 | `src/config.ts`、`src/index.ts` | `tests/config.spec.ts` + `tests/index.spec.ts`：缺省值、自定义值透传 |
| 2 | ✅ 路径安全 | `src/path-security.ts`、`src/file-errors.ts`（错误类 + fs 错误映射单独成文件，避免 path-security 与 file-service 互相 import） | `tests/path-security.spec.ts`：`..` 逃逸、绝对路径逃逸、符号链接（junction）指向根外、根本身、Windows 大小写、`\0` |
| 3 | ✅ 文件服务本地四件套 + 错误映射；远端四方法抛 `UNSUPPORTED` | `src/file-service.ts` | `tests/file-service.spec.ts`：临时目录里列 / 读 / 原子写（中断不留半成品、临时文件被清）/ 10MB 截断 / 父目录不存在 / 列子目录 |
| 4 | ✅ 控制面端点 `files.tree/read/write/dirs` + `sessions.send`（一次 sendAndWait，透传 `source`/`wait`） | `src/remotes.ts` | `tests/remotes.spec.ts` 增：四个 files 端点、`sessions.send` 返回 SendResult、错误码透传 |
| 5 | ✅ TC 解析器 | `src/tc-parser.ts` | `tests/tc-parser.spec.ts`：用真实样例整段跑（目标切换 / 多目标 / 标题不重置 / `###` 发送 / `##` 跳过 / 空目标块 / 默认 0）、`resolveTargetsAt`、`sectionRange` |
| 6 | ✅ 前端 RPC 类型 + 本地文件面板（收起条 / 展开 / 面包屑 / 换目录弹窗 / 双击打开） | `client/files/*`、`client/styles/files.ts`、`client/TerminalWorkspace.tsx`（只加一行挂载） | `tests/client-files.spec.ts`：`useLocalFs` 的路径与状态逻辑（纯逻辑抽出来测）；手工：DSH 3180 里点一遍 |
| 7 | ✅ 浮动编辑器窗 + Tab 管理（先用 textarea 占位内容区） | `client/editor/EditorWindow.tsx`、`useFloatWindow.ts`、`editorStore.ts`、`client/styles/editor.ts` | `tests/client-editor-store.spec.ts`：开 / 关 / 切换 / 脏标记 / 关前确认状态机；手工：拖 / 缩 / 最大化 / 最小化 |
| 8 | ✅ CodeMirror 6 接入：语言包、Ctrl+S 保存、选区回调、只读、主题跟随 DSH 明暗 | `client/editor/CodeEditor.tsx`、`cmTheme.ts`、`lang.ts` | ✅ 产物 `client.js` 745KB → **1.87MB**（markdown 语言包连带拉入 css/js/html 高亮与 autocomplete）；**偏离**：CodeMirror 样式由 style-mod 自注入，不需要 `tm:codemirror-css` 虚拟模块，tsdown 配置未动 |
| 9 | ✅ TC 徽章（窗格标题 + 活跃会话项）+ 拖动语义提示 | `client/TermView.tsx`、`client/ConnectionsPanel.tsx` | 手工：拖动后编号跟着变；单终端手柄禁用 |
| 10 | ✅ TC 执行：runScript 状态机（冻结映射、逐条 `sessions.send`、超时跳过 / 中止）+ 确认框 + 汇总条 + 右键菜单（执行选中 / 执行本节） | `client/tc/runScript.ts`、`TcConfirmDialog.tsx`、`TcSummaryBar.tsx`、`client/styles/tc.ts` | `tests/client-tc-run.spec.ts`：用假 rpc 跑真实样例片段（顺序、跳过、无对应终端标 ✗、中止）；手工：对两台 mock 设备跑 `[hdd启动]` 节 |
| 11 | ✅ 发送选中弹窗 + 按钮可用性矩阵 | `client/tc/SendSelectionDialog.tsx` | 手工：`.md` 只能发送选中；`.txt` 两个都能；其他禁用 |
| 12 | ✅ 收尾：spec/plan/CLAUDE 同步、测试基线数字、README「文件访问范围」 | 文档 | 见下「S1–S3 证据」 |

**S1–S3 证据（2026-09-02）**
- 步骤 2–11 全部完成，提交链：`d4b131c`（1）→ `adfdbcf`+`f02a90f`（2）→ `df36a46`（3）→ `cf22108`（4）→ `6991404`（5）→ `7cd5cbe`（6）→ `13e6ccf`（7）→ `9f8ff2d`（8）→ `a64396f`（9–11）
- `pnpm test`：**275 项全绿**（26 个 spec 文件；本分支新增 90 项）；覆盖率 84.5 / 74.4 / 83.7 / 86.9（阈值 72/72/60/74）
- `pnpm build`：host 57KB；client.js **1.91MB**（CodeMirror 全量，设计方案 2.7 方案 B）
- 手工验收（DSH 3180 + mock-device 2323/2324）：本地文件面板展开 / 面包屑 / 换目录选择器 / 双击打开 → 浮动编辑器（CodeMirror markdown 高亮、拖动、Tab、底栏）→ 连接两台 mock 后窗格与活跃会话项显示 TC0/TC1 → 打开 TC 脚本点「执行脚本」→ 映射确认框（TC0/TC1 各 3 条、TC5 无对应终端、第 6 行「间隔」提示）→ 确认后逐条发送、终端回显、汇总条 ✓6 ✗1、toast → 选中两行点「发送选中」→ 终端多选弹窗默认勾 TC0
- **审查（2026-09-02，子 agent 只读审查 `badc5fb~1..HEAD`）**：高 1 / 中 1 / 低 3 / nit 5，结论「可合并，先修高与中」。已修：① 高——`/term-manager` 回 `ACAO:*` 且无来源校验，`files.write` 暴露给互联网网页 CSRF → 加 `isTrustedOrigin` 来源围栏（loopback / 同 Host 放行，其余 403，CORS 头只回显允许来源），测试 5 项；② 中——保存期间继续编辑会被误清脏、关 Tab 静默丢字 → 按「当前内容 vs 写入内容」重算脏标记，测试 1 项；③ 低——进不去的目录不再改 cwd；`init` 并发只问一次后端（测试 2 项）；④ nit——右键菜单监听器依赖、发送选中掉线兜底。未修：「符号链接逃逸」用例在无权限的 Windows 上会 skip（建议 CI 用 Linux runner 跑一次）；`###` 整行发送语义待与脚本作者确认。测试 282 项全绿。
- **偏离记录**：① 步骤 8 不需要 `tm:codemirror-css`（CodeMirror 自注入样式）；② 步骤 9–11 合成一个提交；③ 「发送选中」默认勾选 TC0 而非「当前激活终端」（工作区没有激活终端概念）；④ 同一脚本行的多个目标并行发送、不同行串行（设计说逐条串行，这里按设备并行更快且顺序语义不变）；⑤ 新增 `client/tc/ContextMenu.tsx`、`TcDialogs.tsx`、`tcRunStore.ts`、`client/toast.ts`、`ToastHost.tsx`、`src/file-errors.ts`（计划未列）

**风险与对策**
- CodeMirror 打包体积与 tsdown 兼容性：第 8 步单独一个提交，若产物异常可回退到 textarea 继续后面步骤。
- `TerminalWorkspace.tsx` 是与同事分支的潜在冲突点：只在广播栏下方加一行 `<FilePanel />` 挂载和一行 `<EditorWindow />`，其余逻辑都在新目录里。
- TC 6 项暂定决策若会后有变：只改 `tc-parser.ts` / `runScript.ts`，UI 不动。
- 路径安全是唯一的安全敏感点：第 2 步测试先于实现写（逃逸用例必须先红后绿）。

### 用户验收修订（2026-09-02 第二轮）

| # | 修订 | 做法 | 状态 |
|---|---|---|---|
| R1 | 文件面板工具栏只放图标，悬停出提示 | 「上一级 / 换目录 / 刷新」去掉汉字，`title` 提示 | ✅ |
| R2 | 编辑器最小化不占一整条，缩成一个小图标 | 底部角落 36px 圆形图标 + 文件数角标，悬停提示，点击还原 | ✅ |
| R3 | 覆盖率提升到 90% | 补了 7 个测试文件 30 项（`ambiguity` / `tools-extra` / `remotes-register` / `file-errors` / `ws-io-extra` / `transport-extra` / remotes 重连与取消）。结果（src-only）：**语句 93.3 / 分支 85.5 / 函数 93.5 / 行 95.7**；阈值改为 90 / 80 / 90 / 90 并入 `vitest.config.ts`。分支没定 90：剩下的是 ssh2 内部错误分支（shell 建立失败、连接后报错）和 Telnet socket 错误回调，要造这些场景得改传输层或引入更重的假设备，收益不值 | ✅ |
| R4 | 建人工测试目录，含所有能打开的文件类型，并逐个看打开效果 | `evals/manual-files/`（README 说明每个文件的预期）；浏览器逐个双击截图核对 | ✅ |
| R5 | TC 语法按真实样例做一个人工测试文件 | `evals/manual-files/tc-sample.txt`（真实样例脱敏：地址 / 账号替换，结构原样） | ✅ |
| R6 | 文件面板上方的工具栏 / 面包屑可横向滑动 | 不换行 + `overflow-x:auto`，窄窗口拖动或滚轮滑 | ✅ |
| R7 | 浮动编辑器整条标题栏都能拖（原来标签区被排除，只剩左上角一小块） | 标题栏任何空白处按下即拖；点在标签 / 按钮上仍是原语义 | ✅ |
| R8 | 缩放要四角四边都行，行为同浏览器 | 8 个把手（`applyResize` 纯函数：拖左 / 上边时对边不动，最小尺寸与视口边界钳住），测试 10 组几何 | ✅ |
| R9 | 本地文件面板高度可改：顶部横条上下拖 | 展开时拖横条改高度（120 到视口 70%），记在 localStorage；没拖动只是点击 = 展开 / 收起 | ✅ |
| R0 | Excel（.xlsx）不自己编辑，交给系统默认程序打开 | 新端点 `files.open`：路径围栏内的文件 → `start` / `open` / `xdg-open`；面板双击非文本文件即走此路（右键也有「用系统程序打开」） | ✅ |

### 分支 `feat/sep-s1-files` S5 细化计划（文件传输 + 远端面板，2026-09-02 开工）

设计源：设计方案 3.2（模块三：文件上传 / 下载）+ 2.3（远端文件面板，已确认 2026-09-01）。归属已定：后端由本插件自研，扩展模块负责人复用。每步「代码 + 测试」一个提交，`pnpm build` + `pnpm test` 全绿才进下一步；偏离本表即同提交改本文。

| # | 步骤 | 文件 | 测试 / 证据 |
|---|---|---|---|
| 1 | Transport 接口加可选 `getSftp()`；`transport/ssh.ts` 保存 Client 引用（连接期与连接后都持有），实现懒开 sftp 子通道；断连后取用报 DISCONNECTED | `src/transport/types.ts`、`src/transport/ssh.ts` | `tests/transport-extra.spec.ts` 增：open 会话可取 sftp；close 后取用抛 DISCONNECTED |
| 2 | `src/transport/sftp.ts`：Sftp 门面（list / put / get / mkdirs），fastPut/fastGet step 进度节流 200ms，上传中断清理远端半成品，错误映射 REMOTE_IO / FILE_TOO_LARGE | `src/transport/sftp.ts` | `tests/sftp.spec.ts`：内嵌 ssh2 mock sftp 服务器（复用 mock-ssh-device 思路）测 list/put/get/进度回调/失败清理 |
| 3 | SessionManager：`getSftp(sessionId)`（要求 open 且 ssh，telnet 抛 UNSUPPORTED）+ `runTransfer(sessionId, fn)` 独占锁（传输期间外部 sendAndWait/sendImmediate 报 SESSION_BUSY，传输内部命令免检直写） | `src/session-manager.ts` | `tests/session-manager.spec.ts`（或 transport 相关）增：busy 隔离、telnet 会话取 sftp 抛 UNSUPPORTED、断开会话传输中止 |
| 4 | FileService 远端四件套（SSH 路径）：listRemote → sftp.list；upload（来源 local ref / stream）；download（流，HTTP 直管响应）；downloadToLocal（限本地树根）；传输结束派发 `file` 事件（契约 events.ts） | `src/file-service.ts`、`src/index.ts`（接线 events） | `tests/file-service.spec.ts` 增：挂 mock sftp 会话测四方法 + 树根逃逸拒绝 + file 事件 |
| 5 | Telnet 命令模拟（实验性）：分块上传（~48KB 原文 → 64KB base64 → `printf '%s' '<块>' >> /tmp/.tm-<rand>.b64` → `base64 -d` → `rm`）/ 分块下载（`tail -c +N \| head -c C \| base64`）；单文件 ≤1MB（超出 FILE_TOO_LARGE）；`telnetFileTransfer=false` → UNSUPPORTED；文件夹传输 Telnet 拒绝 | `src/file-service.ts`（内部分派） | `tests/telnet-transfer.spec.ts`：mock-device 加 base64/printf/od 命令，往返一致性 + 超 1MB 拒绝 |
| 6 | 控制面：RPC `files.remoteTree`（= listRemote）；HTTP `/term-manager/files/upload`（POST raw body，query sessionId/remotePath/name）与 `/term-manager/files/download`（GET 流式 + content-disposition）；`/term-io` 下行 `file-progress` 帧（节流后转发） | `src/remotes.ts`、`src/ws-io.ts`、`src/index.ts` | `tests/remotes-files.spec.ts` 增 upload/download 路由（假 deps）；`tests/ws-io-extra.spec.ts` 增进度帧 |
| 7 | AI 工具 `tm_upload`（sessionId/localPath/remotePath）/ `tm_download`（sessionId/remotePath/localPath?；无 localPath 返回浏览器下载 URL）；guard:{}，presentCall 卡片 = 文件名 + 方向 + 大小 | `src/tools.ts` | `tests/tools-extra.spec.ts` 增：参数校验、成功/失败分支、presentCall |
| 8 | 前端远端文件面板：收起条/展开（同本地面板交互）、切终端 chips（只列 open 会话，Telnet 且关开关时按钮禁用并标实验性）、面包屑/上一级/刷新、6 按钮（上传文件/上传文件夹/下载文件/下载文件夹/刷新），与本地面板联动（本地选中 → 上传到远端当前目录；远端选中 → 下载到本地当前目录）、同名冲突（覆盖/跳过/重命名）、进度条（WS 帧 + toast） | `client/files/RemoteFilePanel.tsx`、`client/files/remoteFs.ts`、`client/styles/files.ts`、`client/TerminalWorkspace.tsx`（一行挂载） | `tests/client-files.spec.ts` 增（remoteFs 纯逻辑）；手工：对 mock SSH 设备传/取文件、对 mock Telnet 设备跑 base64 往返 |
| 9 | 编辑器底部 [📤 上传]：当前编辑文件 → 终端多选弹窗（复用发送选中的弹窗样式）→ 进度 | `client/editor/EditorWindow.tsx` | 手工 |
| 10 | 收尾：spec/plan/CLAUDE/README 同步（远端面板 + 文件传输 + tm_upload/tm_download）、`scripts/mock-ssh-device.mjs` 加 sftp 支持、smoke-e2e 加传输场景 | 文档、scripts | build + test 全绿 + 手工验收清单补条目 |

**S5 风险与对策**
- ssh2 的 sftp 依赖服务端开 sftp 子系统：真实网络设备很多没有 sftp——面板按钮失败时提示「设备未开 SFTP」，Telnet 模拟作为兜底路径（设计已定）。
- Telnet 下载受环形缓冲 1MiB 限制：分块读（每块 ≤256KB 原文）绕开，不指望单条命令拿全量输出。
- 远端路径无树根概念（`..` 交设备自己解释）：listRemote/upload/download 只做基本规范化（`\0`、空路径拒绝），不做围栏——远端本来就是全盘可见的（与 SSH 终端同等权限），UI 面包屑防止误操作即可。
- `TerminalWorkspace.tsx` 仍是最小改动：远端面板插在本地面板上方一行。

### 用户验收修订（2026-09-02 第三轮）

| # | 问题 | 根因 / 做法 | 状态 |
|---|---|---|---|
| 1 | 上下拖动本地文件面板顶栏时，会在已打开的终端里"输入字符" | 根因：`tm-fpBar` 的 pointerdown 没 `preventDefault()`（编辑器窗的拖动有），按下图标/文字会启动浏览器原生拖拽，拖到终端上松手被 xterm 的 drop 处理当输入打出去。补 `preventDefault()` + `.tm-fpBar` 禁用原生拖拽（`-webkit-user-drag:none`） | ✅ |
| 2 | （F22）「换目录」到 D:\ 之后回不去工作区 | 文件面板工具栏加「回到工作区目录」按钮：`LocalFsState.workspaceRoot`（init 时始终问一次后端 `files.root`，Config 改了也能跟上），`goWorkspace()` 走既有 `setRoot`（记忆 + 列表）；工作区未知时按钮禁用 | ✅ |
| 3 | （F25）编辑器拖到屏幕下边缘，窗口高度"自动减小" | 根因：`clampMove` 把 y 钳在 `vh-60`，窗口悬出视口只剩一条标题栏，看起来像高度被压小。改为下边钳到「整个窗口可见」（`y ≤ vh-h`，与横向钳制一致，行为同浏览器窗口）；clampMove 测试同步更新 | ✅ |
| 4 | 发送选中加「不再提示」；目标按广播栏当前所选 | 勾选后（sessionStorage `tm.tc.sendSkipConfirm`，重开工作区恢复弹框）按钮和右键都直接发送，不再弹框；默认目标 = 广播栏所选 ∩ 在线（`pickSendTargets` 纯函数，没勾 = 第一台在线、不误发全部）；弹框默认勾选同步跟随广播栏。**后端无改动**（`sessions.send` 端点已有） | ✅ |
| 5 | 拖面板顶栏时 Telnet 终端仍回显乱码（真机） | 真根因是**窗口尺寸同步洪泛**，与拖拽无关：拖动顶栏 → 终端网格每帧变高 → ResizeObserver 每帧发 resize → 后端每帧给设备发一条 NAWS 子协商，弱 telnetd 解析不过来把协商字节当输入回显成乱码。修三层：① `client/TermView` resize 防抖 150ms（停稳才同步，SSH 也受益）；② `transport/telnet.ts` NAWS 防抖 + 尺寸不变不重发 + RFC 1073 的 0xFF 转义（连接时的 80x24 立即发，#18 修复不受影响）；③ `scripts/mock-device.mjs` 剥掉入站 IAC（之前不剥，自己也会把 NAWS 当输入回显）。测试：抖动只出 1 条且为最后尺寸 | ✅ |
| 6 | 「不再提示」的行为没在弹窗里提示（只靠悬停 title） | 勾选复选框时弹窗内出现明文说明：按钮和右键都直接发送、目标 = 广播栏当前所选（没勾 = 第一台在线）、重开工作区恢复弹框 | ✅ |

### 扩展模块轨道（扩展模块负责人）——待补充

需求文档成稿后由扩展模块负责人在此补：里程碑、订阅的事件、落盘格式、路由 / UI 入口、测试点。主线只承诺：契约不单方面改；`registerExtensions` / `registerClientExtensions` / `EXT_CSS` 三个挂载点稳定；S4 留 2 天联调。

### 开放问题（九月）

1. TC 语法真实样例未到——解析器按原型设想语法先做，样例到位后只改 `tc-parser.ts`。
2. `.xlsx` 本期不做（设计方案 3.9）。
3. 浮动编辑器 z-index 与 DSH 模态的冲突——60~90 区间，遇到再让位。

## 证据

- `tests/` 167 项全绿；`pnpm build` 产出 host + client 双半包；覆盖率阈值 72/72/60/74。
- 真实启动冒烟：DSH profile tm-dev，`/plugins/dsh-terminal-manager/client.js` 200 + 首页含 `dsh-terminal-manager` 行。
- `scripts/smoke-e2e.mjs` 19 场景对活服务。
