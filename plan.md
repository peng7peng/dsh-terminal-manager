# DSH Terminal Manager — 构建计划

- 派生自：`spec.md`（唯一设计源，已合并原 `docs/solution.zh.md`）
- 状态：MVP M0–M5 已全部完成（2026-08-26）；**九月迭代已开工（2026-09-02，见文末「九月迭代」）**；本文件按 SDLC 规则 6 随实现偏离同步更新
- 日期：2026-08-25
- 修订：
  - 2026-08-25 插入「方案讲解 + GUI 方案选型」里程碑（M1）
  - 2026-08-28 同步真实实现的偏离（见下「实现偏离记录」）；`docs/connections-panel-upgrade.zh.md` 的剩余待办并入本文「后续待办」段，原文件已归档
  - 2026-09-02 追加「九月迭代」计划：契约先行 PR + 主线 S1–S5 + 扩展模块轨道
  - 2026-09-03 补齐扩展模块「端口映射 / 会话共享 / 日志」E0–E8 文件级计划；产品负责人已批准，进入 Build
  - 2026-09-07 契约审查 P1/P2 修复：连接超时统一毫秒、凭据结构统一嵌套 auth（偏离记录 7–8）
  - 2026-09-09 `feat/remote-file-toolbar` 分支：远端文件面板工具栏 + files.remoteCwd RPC + 测试批次 1（偏离记录 16–17）

## 实现偏离记录（规则 6：偏离即同提交更新）

实施中相对原计划的偏离，均在 `spec.md` 体现为真实设计：
1. **控制面**：原计划走 `ctx.typert.remotes` 的 `/api` RPC；实际改为 `ctx.webServer.register` 独立前缀路由 `/term-manager`（绕开 connection.rpc 作用域问题 + `/api` 与 api-gateway 冲突），含 OPTIONS 预检。
2. **GUI**：原计划挂「右侧 details 栏 + 终端/连接双页签」；实际改为 `shell.overlay` 全屏覆盖层工作区，终端模块 + 连接面板左右并排（非页签）。
3. **终端宽度**：原计划未定；实际做了响应式——终端模块目标宽 480、未拖动时聊天填满左侧无留白、拖动上限随视口动态 `max(760, 视口宽-764)`、终端网格 `auto-fit + 1fr` 填满。
4. **Telnet**：原计划裸 TCP 透传；实际加 `telnetMode: 'telnet'|'raw'`，telnet 模式剥离 IAC（Buffer 操作、只剥离不回发）。
5. **连接配置**：新增 `telnetMode`/`handshakeTimeoutSec`/`newline`/`localEcho`/`guardWhitelist`/`timeoutMs` 字段；sendAndWait 用配置的换行。
6. **文件名**：原计划的 `TerminalPanel.tsx`/`ConnectionsTab.tsx`/`TerminalsTab.tsx`/`*.module.css`/`config.ts` 均未采用；实际见下「改动文件（真实）」。
7. **连接超时单位统一为毫秒（2026-09-07，契约审查 P1）**：`ConnectionConfig.handshakeTimeoutSec`（秒）改名 `connectTimeoutMs`（毫秒），与契约 `ConnectTarget`、`TransportConnectOptions` 三处同名同单位；`session-manager.ts` 的 `connectByConnId` / `reconnect` 两处 `* 1000` 转换删除，直接透传；UI（`client/ConnectionsPanel.tsx`）仍以秒展示（15/30/60/120/180 下拉框），保存 ×1000、回显 ÷1000。
8. **凭据结构统一为嵌套 auth（2026-09-07，契约审查 P2）**：`AuthConfig` 判别联合定义收敛到契约 `src/types/session-api.ts`（`connection-store.ts` 删本地定义，改 import + re-export）；`ConnectTarget` / `TransportConnectOptions` 扁平 `password/privateKey/passphrase` 改嵌套 `auth?`（`transport/ssh.ts` 从 `options.auth?.kind` 取凭据）；`session-manager.ts` 三处拆装转换（`connectByConnId` / `connect` / `reconnect`）删除，直接透传。边界转换收敛两处：`remotes.ts` `sessions.connect`（前端扁平 payload → auth，前端不感知）、`tools.ts` `tm_connect`（AI 扁平 password → auth，AI 参数 schema 不变）；`smoke-e2e.mjs` 传 RPC payload 不受影响，`src/ext/port-log/` 不引用 `ConnectTarget` 不受影响，`transport/telnet.ts` 不用凭据。

## 改动文件（真实，M0–M5 已落地）

### host 半（`src/`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 入口：装配 ConnectionStore、SessionManager、`tm_*` 工具、`/term-manager` 路由、`/term-io` WS；`ctx.effect` 清理 |
| `src/connection-store.ts` | 连接配置 CRUD + JSON 持久化（0600）+ 校验；含 telnetMode/connectTimeoutMs/newline/localEcho 等字段（connectTimeoutMs 原名 handshakeTimeoutSec，2026-09-07 统一，见偏离记录 7） |
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
| **S5 文件传输 + 远端面板** | `transport/ssh.ts` 导出 `getSftp()`（复用 Client 开 sftp 通道）→ `transport/sftp.ts`（协议无关 SftpLike 门面）；`FileService` 远端四件套（SSH/SFTP 路径；Telnet 会话抛 UNSUPPORTED——base64 模拟已砍）；`/files/upload`（POST raw）/ `/files/download`（GET 流式另存为）路由 + `/term-io` `file-progress` 帧（transferId 关联 + 终态帧）；远端文件面板（切终端 chips、3 按钮、同名覆盖/跳过/重命名）+ 本地面板联动上传/下载；`tm_upload` / `tm_download`；`file` 事件派发 | S1（可与 S3 并行，最后合） | 8 天 | ✅ 2026-09-03（步骤 1–9，2f1065a + 收尾提交）；**2026-09-03 计划定稿（需求变动见下节）** |

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

### 分支 `feat/sep-s5-transfer` S5 细化计划（文件传输 + 远端面板，2026-09-02 开工；2026-09-03 定稿）

设计源：设计方案 3.2（模块三：文件上传 / 下载）+ 2.3（远端文件面板，已确认 2026-09-01）。归属已定：后端由本插件自研，扩展模块负责人复用。每步「代码 + 测试」一个提交，`pnpm build` + `pnpm test` 全绿才进下一步；偏离本表即同提交改本文。

**2026-09-03 定稿的需求变动（用户确认）**：

1. **砍 Telnet 文件传输**：原 base64 命令模拟兜底不做，Telnet 会话远端操作一律 `UNSUPPORTED`；`telnetFileTransfer` 死字段清理。
2. **砍文件夹传输**：本期只做单文件。远端面板 3 按钮（上传文件 / 下载文件 / 刷新）；本地面板补「上传文件 / 下载文件」联动按钮。
3. **下载双入口**：远端面板 [📥 下载] → GET `/files/download` 流式路由，浏览器另存为（用户选任意目录）；本地面板 [📥 下载] → `downloadToLocal`（联动存到工作区当前目录，即「路径②」）；AI `tm_download` 也走 `downloadToLocal`。另存为（「路径③」）要不要行内进度条周五交互会再定。
4. **路径② `downloadToLocal` 要行内进度条（用户 2026-09-03 拍板）**：WS `file-progress` 帧 + transferId 机制确定保留，不是可裁项。
5. 交互细节（③ 行内进度条、拖拽行为、脏修改提示、进度条样式）周五开会定，前端步骤（8）留占位。

**关键架构决定**：

- **零契约改动**：transferId 只出现在 HTTP query / RPC payload 与 WS 帧（OutFrame 是主线自有类型），由路由组装帧时塞入；`TransferProgress` / `events.ts` 均不动，无需契约 PR。`SessionManager.getSftp` 是主线方法，不进 session-api 契约（扩展模块走 FileService 拿文件能力）。
- **无传输独占锁**：SFTP 是 SSH 独立子通道，不碰 PTY 字节流，与 `sendAndWait` 互不干扰；原计划的 `runTransfer` SESSION_BUSY 锁砍掉——上锁只会造成「传大文件时终端不让打字」。
- **协议无关接口**：`transport/types.ts` 声明纯接口 `SftpLike`（list / stat / mkdirs / put / get / downloadStream，不 import ssh2）；`SftpFacade`（`transport/sftp.ts`）implements；ssh.ts 的 `getSftp` 返回门面实例。unlink/rename 暂不进接口（门面内部用）。
- **进度帧广播 + 前端过滤**：`registerWsIo` 返回 `{ disposer, broadcastFileProgress }`（新增 B7a→B7b 依赖边，index.ts 接线进 RemoteDeps）；帧广播给所有 WS 连接，前端按 transferId 过滤（服务端当不透明字符串回显，限长 ≤64）；路由在响应 finish/close 补发**终态帧**（`done` + `ok`/`error`）——另存为导航式下载前端看不到 HTTP 响应，终态帧是唯一完成/失败信号；XHR/fetch 路径仍以响应 settle 为准（双保险）。
- **`file` 结束事件**：成功 / 失败 / 取消都发（失败也是 ok:false）；`path` = 远端路径（upload=目标 / download=源）。事件总线不发进度。
- **并发先不限**：每次 getSftp 开新 SFTP 子通道（sshd 默认 MaxSessions 10），观察后再说。

| # | 步骤 | 文件 | 测试 / 证据 |
|---|---|---|---|
| 1 | ✅ Transport 接口加可选 `getSftp()`；SSH 懒开 sftp 子通道；断连 DISCONNECTED / 设备未开子系统 PROTO_ERROR（fa3e3fd；返回类型修订 SftpLike 随步骤 2） | `src/transport/types.ts`、`src/transport/ssh.ts` | `tests/transport-extra.spec.ts` 增 3 项：open 会话可取 sftp；close 后 DISCONNECTED；未开子系统 PROTO_ERROR |
| 2 | ✅ SFTP 门面 SftpFacade（list / stat / mkdirs / put / get / downloadStream）+ SftpLike 接口修订（types.ts 删 ssh2 import、ssh.ts 返回门面）+ 上传临时文件 `<目标>.tm-partial-<rand>` + rename 落位 + 进度节流 200ms（2e77c1f；mock 设备目录句柄 CLOSE 修复随本步） | `src/transport/sftp.ts`、`src/transport/types.ts`、`src/transport/ssh.ts` | `tests/sftp.spec.ts`（mock SFTP 设备进 `tests/helpers.ts`）：put（路径 / 流 / 覆盖 / 中断清理）/ get（NOT_FOUND / FILE_TOO_LARGE / 目录）/ list / stat / mkdirs / downloadStream / 进度终值 |
| 3 | ✅ SessionManager `getSftp(sessionId)`（无锁版：requireOpen + 返回门面）+ FileService 协议分派骨架（Telnet → UNSUPPORTED）（7cdab30） | `src/session-manager.ts`、`src/file-service.ts` | 会话相关测试增：telnet → UNSUPPORTED、closed → DISCONNECTED |
| 4 | ✅ FileService 远端四件套（SSH 路径）+ `file` 结束事件（构造加 `events: TmEventBus`，成功/失败/取消都发）+ downloadToLocal 本地半成品保护（temp + rename）（1a68d41） | `src/file-service.ts`、`src/index.ts`（接线 events） | `tests/file-service.spec.ts` 增：四方法（挂 mock SFTP 会话）+ file 事件 + 树根围栏（downloadToLocal） |
| 5 | ✅ `telnetFileTransfer` 死字段清理（aba30c5；evals 样例 config 一并清） | `src/config.ts`、`tests/config.spec.ts`、`tests/index.spec.ts`、`tests/remotes-files.spec.ts` | build + test 全绿 |
| 6 | ✅ 控制面：RPC `files.remoteTree` / `files.downloadToLocal`；HTTP `/term-manager/files/upload`（POST raw，`createHttpHandler` 入口内分流，直接 pipe req）/ `/term-manager/files/download`（GET 流式另存为：前置 stat、content-disposition 文件名 RFC 5987 编码、no-store）；`/term-io` `file-progress` 帧（含终态 done/ok）+ broadcaster 接线（`registerWsIo` 返回 `{ disposer, broadcastFileProgress }`）（0d57f67） | `src/remotes.ts`、`src/ws-io.ts`、`src/index.ts` | `tests/remotes-files.spec.ts` 增 upload/download 路由（假 deps）；`tests/ws-io-extra.spec.ts` 增进度帧 |
| 7 | ✅（0fdd925）AI 工具 `tm_upload`（localPath 绝对路径 + `resolveInsideRoot` 围栏，工具描述教 AI 先 `files.root`）/ `tm_download`（localPath 必填：AI 先 `files.root` → `downloadToLocal` 进树根 → `files.read`）；guard:{}，presentCall 卡片 = 方向 + 源/目标路径（偏离 12） | `src/tools.ts` | `tests/tools-extra.spec.ts` 增：参数校验、成功/失败分支、presentCall |
| 8 | ✅（2f1065a）前端：远端面板 3 按钮 + chips（仅在线 SSH 会话，无 SSH 提示「请先连接 SSH 设备」）+ 面包屑/刷新 + 同名冲突（覆盖/跳过/重命名）+ 进度条（② downloadToLocal 确定行内；③ 另存为行也进传输条、终态帧收尾）+ OS 拖拽单文件直传 + 本地面板联动上传/下载按钮 + 编辑器上传入口（实际落地细节见偏离 13/14） | `client/files/RemoteFilePanel.tsx`、`client/files/remoteFs.ts`、`client/ws.ts`（file-progress 帧）、`client/files/FilePanel.tsx`（联动按钮）、`client/styles/files.ts`、`client/TerminalWorkspace.tsx`（挂载 + 进度帧接线） | `tests/client-files.spec.ts` 增 8 项（remoteFs 纯函数 + store + 传输/冲突/进度帧）；`tests/remotes-files.spec.ts` 增 `files.uploadLocal`；手工：对 mock SSH 设备传/取文件（随步骤 9 冒烟补） |
| 9 | ✅（本提交）收尾：spec（B6 八只手 + F7b 远端面板 + B7a 传输路由/端点订正）/plan/CLAUDE（基线 370 + 坑 11）/README（远端面板 + 文件访问范围 + 已知限制）同步；`scripts/mock-ssh-device.mjs` 加 SFTP 子系统（远端 / 映射到本地根目录，参数第三个位指定）；smoke-e2e 加 E-S5 两场景（remoteTree + uploadLocal/downloadToLocal 往返） | 文档、`scripts/mock-ssh-device.mjs`、`scripts/smoke-e2e.mjs` | build + test 全绿；手工验收清单见下节 |

**偏离记录（相对 2026-09-02 原十步计划，规则 6）**：

1. Telnet base64 模拟整步砍（步骤 5 → `telnetFileTransfer` 死字段清理）；文件夹传输砍（6 按钮 → 3 按钮 + 本地面板联动按钮）——用户 2026-09-03 确认。
2. `runTransfer` SESSION_BUSY 独占锁砍掉：SFTP 独立子通道不碰 PTY，传输与打命令互不干扰；步骤 3 缩为 `getSftp(sessionId)` 无锁版。
3. `Transport.getSftp` 返回协议无关 `SftpLike`（原实现直返 ssh2 `SFTPWrapper`，违反 types.ts「协议无关」原则）；复用步骤 2 的 SftpFacade 作适配层。
4. 契约零改动：原计划「`TransferProgress` 加 transferId 的契约 PR」取消——transferId 由路由组装进 WS 帧，不进契约。
5. broadcaster 接线：`registerWsIo` 返回值从裸 disposer 变 `{ disposer, broadcastFileProgress }`，新增 B7a→B7b 依赖边。
6. 进度帧带终态（done + ok/error）：另存为导航式下载没有 HTTP 响应可看，终态帧是唯一完成/失败信号。
7. downloadToLocal 补本地半成品保护（temp + rename）——原计划 fastGet 直写目标，中断留半个本地文件。
8. mock SFTP 设备放 `tests/helpers.ts`（原计划「tests/sftp.spec.ts 内嵌」；helpers 按约定只增不改）。
9. 步骤 3 的依赖注入形状：`LocalFileService` 构造加 `sessions?: FileSessionGateway`（结构化最小面 = `get` + `getSftp`，index.ts 注入 SessionManager，避免 file-service ↔ session-manager 互相 import）；SessionManager.getSftp 的 Telnet 防御分支用 DISCONNECTED 码 + 说明消息——契约 `SessionErrorCode` 无 UNSUPPORTED（零契约改动），协议分派的 UNSUPPORTED 由 FileService 按会话快照 protocol 给出，直调 SessionManager.getSftp 的场景正常不存在。
10. `file` 事件发射边界：`requireSftp` 分派层失败（会话不存在 / 已断开 / Telnet）**不发**事件（属 API 误用，步骤 3 测试直接断言错误码）；请求进入传输后的所有失败（含本地围栏 PATH_OUTSIDE_ROOT）都发 ok:false。流式 `download` 的结束事件挂在返回的流上（end=成功 / error=失败 / close 未 end=取消「传输被取消」）——另存为导航式下载同样适用。
11. 步骤 6 补充决定：契约 `FileRpcAction` 不加新动作名（零契约改动，该类型无消费者，`files.remoteTree` / `files.downloadToLocal` 只作为 endpoint 字符串存在）；传输路由（upload/download）响应体用 `{ok, value|error}` 裸信封（非 RPC `server-response` 封包），错误状态码 NOT_FOUND → 404、其余 → 400；终态帧三条路都发（RPC 成功/失败、upload 成功/失败、download 管道 finish/出错），`transferId` 缺省时服务端 randomUUID 生成（RPC 响应回传）；OPTIONS 的 allow-methods 加 GET。
12. 步骤 7 落地细节：`registerTerminalTools(ctx, sessions)` 改为 `registerTerminalTools(ctx, { sessions, files, workspaceRoot })`（传输工具需要文件服务与树根；index.ts 传解析后 cfg.workspaceRoot）；工具错误统一折叠成「CODE: 消息」（复用 toError 风格，AI 可自纠）；presentCall 在执行前拿不到大小，卡片 = 方向 + 源/目标路径，大小在结果文本里（「文件名+方向+大小」拆两半）。
13. 步骤 8 补控制面入口 `files.uploadLocal`（仅 dispatch 端点字符串，零契约改动）：本地面板 / 编辑器的文件在 host 磁盘上，浏览器拿不到字节，联动上传必须由后端按树根围栏读盘（`UploadSource` local ref）再推 SFTP；进度与终态帧走同一条 `broadcastFileProgress` 路。原计划的「拖拽后端无新 API」只对浏览器文件直传成立（OS 拖拽 = XHR raw 路由）。
14. 步骤 8 前端落地细节：传输进度条集中在远端面板底部（本地/编辑器发起的也在那看，发起时 toast 指路）；② 同名冲突查本地面板当前目录条目（store 依赖注入 `localNames`/`localTarget` 保持纯逻辑）；上传成功自动刷新远端列表、下载成功刷新本地列表；OS 拖拽仅单文件（多个取第一个并提示）；编辑器上传入口 = 底栏按钮 `EditorUploadButton`（注入 EditorWindow actions 槽；脏文件传已保存版本并提示，正式的脏修改交互周五定）；另存为（③）也进传输条但进度仅终态帧可见（导航式下载拿不到响应，周五再定行内进度）；远端面板固定高度不做拖拽调高。
15. **步骤 9 后的审查修复轮（2026-09-03，REVIEW.md 三轮：缺陷 / 安全 / 合规；合规轮通过，helpers.ts import 区 2 行字面删改语义纯增量放行记录）**。已修：① H1——`connectSsh` 的 SFTP 子通道按连接复用（原每操作新开且永不关闭，真实 OpenSSH MaxSessions=10 会把远端功能用瘫；打开失败不缓存可重试，通道自行死亡失效缓存，close 时显式 end）；② M1——`downloadStream` 消费端中止（浏览器取消）→ 底层 SFTP 读流 destroy，不再把整个文件后台拉完；③ M3——会话掉线 `setSession(null)` 保留传输行与 transferId 门（原实现清空 → 在途传输终态零反馈），在途行由服务端失败终态帧收尾；④ L2——切会话使未决冲突决策作废；⑤ L4——失败终态帧 `transferred:0` 不清零已传字节；⑥ 安全高——`/term-io` WS 升级加 Origin 校验（与 /term-manager 同一 `isTrustedOrigin`，原 `isLoopback` 只看可伪造的 Host 头，跨站 WS 劫持可偷终端输出/注入键入）；⑦ mock-ssh-device SFTP 根加越界围栏（`..` 逃逸被拒 PERMISSION_DENIED，真 ssh2 客户端探针验证）。**记档不修（后续轮）**：M2 传输全程无超时/取消（涉及 UI 取消按钮，周五交互会定）；`isTrustedOrigin` 的 Origin===Host 分支可被 DNS rebinding 击穿（既存规则，收紧前需确认用户部署方式——从局域网主机名访问会被挡）；L1 rename 删旧窗口 / L3 失败行无 toast（面板收起时不可见）/ L5 下载 stat 与读取 TOCTOU；ws-io 心跳只 ping 不验 pong（僵尸连接积压 send 缓冲）、handleFileUpload 校验失败不消费 body（keep-alive 复用）、mkdirs 暂无调用方、传输行 30 条上限可能挤出进行中行。

**S5 风险与对策**
- ssh2 的 sftp 依赖服务端开 sftp 子系统：真实网络设备很多没有 sftp——面板按钮失败时提示「设备未开 SFTP」（Telnet 兜底已砍，见需求变动 1）。
- 远端路径无树根概念（`..` 交设备自己解释）：listRemote/upload/download 只做基本规范化（`\0`、空路径拒绝），不做围栏——远端本来就是全盘可见的（与 SSH 终端同等权限），UI 面包屑防止误操作即可。
- GET `/files/download` 另存为在 3180 实测：若插件 UI 跑在 iframe 里，anchor 下载需宿主 sandbox 含 `allow-downloads`（同页挂载无此问题）；不行则退 fetch+blob（大文件内存压力）或与宿主沟通。
- 上传中设备掉线：远端可能残留 `.tm-partial` 文件（best-effort 清理的物理上限），文档记一句。
- `TerminalWorkspace.tsx` 仍是最小改动：远端面板插在本地面板上方一行。

**S5 手工验收清单（DSH 3180 + `node scripts/mock-ssh-device.mjs 2222`；SFTP 根 = 系统临时目录 `mock-ssh-device-files`）**

1. 连 SSH mock 设备 → 远端面板出现会话 chip；点开面板 → chips 单选切换，面包屑从 `/` 开始，双击进目录 / 上一级 / 刷新正常；Telnet 会话不出现 chip。
2. 选中远端文件点 [⬇ 下载] → 浏览器另存为弹出，文件落选目录（中文文件名不乱码）。
3. 远端选中文件 → 本地面板 [⬇] → 文件落本地面板当前目录，远端面板传输条出现行内进度条并 ✓ 收尾；同名时弹冲突框：覆盖替换、跳过不传、重命名落 `a (1).txt`。
4. 本地面板选中文件 [⬆] → 远端当前目录出现文件（host 端读盘路径）；编辑器打开文件 → 底栏 [⬆ 上传到设备] 同样生效。
5. 从资源管理器拖一个文件进远端面板 → 直传成功（多文件取第一个并提示）。
6. `node scripts/smoke-e2e.mjs` 对 3180 跑 21 场景全过（含 E-S5 两个传输场景）。

### 用户验收修订（2026-09-02 第三轮）

| # | 问题 | 根因 / 做法 | 状态 |
|---|---|---|---|
| 1 | 上下拖动本地文件面板顶栏时，会在已打开的终端里"输入字符" | 根因：`tm-fpBar` 的 pointerdown 没 `preventDefault()`（编辑器窗的拖动有），按下图标/文字会启动浏览器原生拖拽，拖到终端上松手被 xterm 的 drop 处理当输入打出去。补 `preventDefault()` + `.tm-fpBar` 禁用原生拖拽（`-webkit-user-drag:none`） | ✅ |
| 2 | （F22）「换目录」到 D:\ 之后回不去工作区 | 文件面板工具栏加「回到工作区目录」按钮：`LocalFsState.workspaceRoot`（init 时始终问一次后端 `files.root`，Config 改了也能跟上），`goWorkspace()` 走既有 `setRoot`（记忆 + 列表）；工作区未知时按钮禁用 | ✅ |
| 3 | （F25）编辑器拖到屏幕下边缘，窗口高度"自动减小" | 根因：`clampMove` 把 y 钳在 `vh-60`，窗口悬出视口只剩一条标题栏，看起来像高度被压小。改为下边钳到「整个窗口可见」（`y ≤ vh-h`，与横向钳制一致，行为同浏览器窗口）；clampMove 测试同步更新 | ✅ |
| 4 | 发送选中加「不再提示」；目标按广播栏当前所选 | 最终行为（含第二轮试用的两处修正）：「不再提示」（sessionStorage `tm.tc.sendSkipConfirm`，重开工作区恢复弹框）**只在广播栏明确勾选了终端时生效**——按钮和右键都直接发给「所选 ∩ 在线」（所选全掉线则报错不发送）；广播栏没勾选时**仍然弹框**（没有明确目标就不盲发）。弹框默认勾选 = 广播栏所选 ∩ 在线，没勾 = 第一台在线（不预选全部）。**后端无改动**（`sessions.send` 端点已有）。修正 ①：`bcTargets` 只传明确勾选（最初误抄了广播的「没勾 = 全部」语义，导致直接发全部远端）；修正 ②：勾了「不再提示」后右键同样直接发（用户确认不要逃生门） | ✅ |
| 5 | 拖面板顶栏时 Telnet 终端仍回显乱码（真机） | 真根因是**窗口尺寸同步洪泛**，与拖拽无关：拖动顶栏 → 终端网格每帧变高 → ResizeObserver 每帧发 resize → 后端每帧给设备发一条 NAWS 子协商，弱 telnetd 解析不过来把协商字节当输入回显成乱码。修三层：① `client/TermView` resize 防抖 150ms（停稳才同步，SSH 也受益）；② `transport/telnet.ts` NAWS 防抖 + 尺寸不变不重发 + RFC 1073 的 0xFF 转义（连接时的 80x24 立即发，#18 修复不受影响）；③ `scripts/mock-device.mjs` 剥掉入站 IAC（之前不剥，自己也会把 NAWS 当输入回显）。测试：抖动只出 1 条且为最后尺寸 | ✅ |
| 6 | 「不再提示」的行为没在弹窗里提示（只靠悬停 title） | 勾选复选框时弹窗内出现明文说明：广播栏勾选了终端时按钮和右键都直接发给所选（掉线不发）、没勾选时仍弹框不盲发、重开工作区恢复弹框 | ✅ |

### 扩展模块轨道：端口映射 / 会话共享 / 日志（扩展模块负责人）

- 派生自：`intent/port-mapping-sharing-log.md`（Accepted）与 `spec.md`「扩展模块」章节（2026-09-03 Approved）
- 开发契约：commit `badc5fb48aa99d7a10d61923e91f9845900cfb6d`
- 计划状态：**Approved；产品负责人于 2026-09-03 批准创建 `feat/sep-port-log` 并开始实现**
- 建议分支：从最新 `origin/main` 建 `feat/sep-port-log`；合并前 rebase 最新 main
- 估算：约 15 人天；E3/E4 可在 E2 后并行，但同一开发者按表顺序完成

#### 不可违反的边界

1. 功能分支不修改 `src/types/`；发现契约不足时停下，另提契约 PR，两人 review。
2. 扩展 host 只 import `src/types/events.ts`、`session-api.ts`、`file-service.ts` 中需要的契约，不 import 主线实现。
3. 主线只动三个挂载点：`src/ext/index.ts`、`client/ext/index.tsx`、`client/styles/index.ts`，且只加入本扩展的 import/调用/样式项。
4. 不修改 `src/index.ts`、`remotes.ts`、`ws-io.ts`、`session-manager.ts`、transport、`TerminalWorkspace.tsx`、`TermView.tsx`、主线 client RPC/WS/store。
5. 测试放 `tests/ext-port-log-*.spec.ts`，helper 新建 `tests/ext-port-log-helpers.ts`；`tests/helpers.ts` 只增不改，本计划不需要碰它。
6. 不新增 tm_* Agent 工具；不改变共享的“对外、无认证、完全可写”产品决定。
7. 所有实现为 TypeScript strict；CSS 只在 `client/styles/port-log.ts`，使用 `.tm-ext-pl-*` 和 `--dsw-*`。

#### 计划文件

| 区域 | 新增文件 | 作用 |
|---|---|---|
| host 壳 | `src/ext/port-log/index.ts`、`types.ts`、`errors.ts` | 扩展装配、私有类型、安全错误 |
| 控制面 | `router.ts`、`sse.ts` | 最长前缀 RPC、来源围栏、SSE 状态 |
| 公共网络 | `network.ts`、`csv.ts` | 地址枚举/校验/错误归一化、CSV 3/5/6 字段 |
| 映射 | `mapping-store.ts`、`mapping-manager.ts`、`tcp-forwarder.ts`、`udp-forwarder.ts` | 持久化、状态机、TCP/UDP 转发 |
| 共享 | `share-manager.ts`、`telnet-server-codec.ts` | 会话事件广播、客户端输入、Telnet IAC |
| 日志 | `app-logger.ts`、`session-log-manager.ts`、`terminal-text-normalizer.ts` | 应用轮转日志、会话输出日志、流式文本处理 |
| browser | `client/ext/port-log/index.tsx`、`rpc.ts`、`store.ts`、`PortLogWorkspace.tsx`、`MappingsTab.tsx`、`SharesTab.tsx`、`LogsTab.tsx` | slot、RPC/SSE、三页签 UI |
| 样式 | `client/styles/port-log.ts` | 扩展独立 CSS |
| 测试 | `tests/ext-port-log-helpers.ts`、`tests/ext-port-log-*.spec.ts` | 假 Socket/会话、各模块单元与集成测试 |

实际命名若因单文件过大拆分，可在本节同步后调整；不得借拆分把代码放回主线目录。

#### E0 基线与垂直空壳（0.5 天）

**状态：Completed（2026-09-03，commit `f1c09a0`）；基线 185 项，空壳接入后 187 项。**

**改动：**

- 从最新 main 建独立分支，记录 `git rev-parse HEAD` 和上游 `../deepseek-harness` 最近三条提交。
- 运行 `pnpm build`、`pnpm test`、`pnpm vitest run --coverage`，记录真实基线；不得低于契约提交的 185 项。
- 建 `src/ext/port-log/index.ts` 和 `client/ext/port-log/index.tsx` 空壳。
- 三个挂载点只加入本扩展一项；新增最小 `tests/ext-port-log-index.spec.ts`。
- 测试证明：host/client 注册各一次，卸载 disposer 各一次，`src/types/` 无 diff。

**退出条件：** 双半包可构建，旧测试全绿，空扩展装卸不改变现有 UI/会话。

#### E1 应用日志 + 扩展控制面骨架（1.5 天）

**状态：Completed（2026-09-03）；与 E2 一并形成首个可用 RPC/SSE 垂直切片。**

**先写失败测试：**

- `ext-port-log-app-logger.spec.ts`：四级过滤、写入顺序、5 MiB 轮转、最多 5 文件、敏感键递归清理、文件失败降级。
- `ext-port-log-router.spec.ts`：最长前缀、POST/OPTIONS、同源与 loopback 围栏、2 MiB 限制、统一错误。
- `ext-port-log-sse.spec.ts`：订阅、断开清理、事件合并、慢浏览器连接隔离。

**实现：**

- AppLogger 写 `dataDir/ext/port-log/log/`；单 Promise 队列，关闭等待刷盘。
- Router 注册 `/term-manager/ext/port-log`；SSE 为其 `/events` GET 子路径。
- 建扩展内部 RuntimeEventHub，不能向冻结 TmEventBus emit 私有事件。
- 先只实现 `appLogs.status` 形成 host→RPC→client 的最小垂直切片。

**退出条件：** 可查询日志状态；制造敏感字段后全目录搜索不到明文；router/SSE 清理后无活动响应或定时器。

#### E2 映射配置、CSV 与网络工具（1.5 天）

**状态：Completed（2026-09-03）；24 个测试文件、205 项测试全绿。**

**先写失败测试：**

- `ext-port-log-store.spec.ts`：端口/地址/域名校验、version 1 加载、临时文件 + rename、权限尽力、重复监听键。
- `ext-port-log-csv.spec.ts`：BOM、空行、引号、IPOP 3/5 字段、扩展 6 字段、IPv6 方括号、1000 行/1 MiB 上限、整批回滚。
- `ext-port-log-network.spec.ts`：本机地址去重排序、固定通配地址、网络错误到安全错误码。

**实现：**

- `mapping-store.ts` 只保存配置，不保存 runtime。
- CSV import 固定 merge；全部校验后一次生成 id/持久化；export 不写临时文件。
- Router 接入 `mappings.list/create/update/remove/importCsv/exportCsv` 和 `network.localAddresses`，此时 start/stop 可返回“尚未实现”测试桩，E3/E4 前不提交为完成状态。

**退出条件：** CSV 导出→清空临时 store→导入后字段一致，失败导入零新增，IPv6 3 字段规则明确。

#### E3 TCP 映射运行时（1.5 天）

**状态：Completed（2026-09-03）；真实本地 TCP echo、并发连接、目标恢复、端口冲突/释放及 IPv6（环境支持时）均有回归。**

**先写失败测试：** `ext-port-log-tcp.spec.ts` 覆盖双向 echo、两个并发连接、目标拒绝、3 秒超时、半关闭、字节/活动计数、端口占用、重复 start/stop、2 秒强制清理、IPv6（环境支持时）。

**实现：**

- `tcp-forwarder.ts` 只管理一条配置的 net.Server 和连接对。
- `mapping-manager.ts` 增加每 id 操作链、状态机、update/remove/autoStart/stopAll。
- 单连接错误更新最近错误但 listener 保持 running；stop 必须最终释放端口。
- 接入 Router start/stop 和 SSE 状态；计数通知 500ms 合并。

**退出条件：** 本地 TCP 端到端测试可重复运行，无悬挂 socket；目标失败后下一客户端仍能成功。

#### E4 UDP 映射运行时（2 天）

**状态：Completed（2026-09-03）；真实本地 UDP 双来源隔离、零长度报文、端口冲突/释放及 IPv6（环境支持时）均有回归。**

**先写失败测试：** `ext-port-log-udp.spec.ts` 覆盖两来源同时不同 payload、响应不串包、零长度报文、IPv4/IPv6 地址族、建连队列上限、1024 peer 上限、60 秒空闲回收、删除/stop 清理。

**实现：**

- 启动时解析 redirectAddr；每个来源端点一个目标 dgram socket。
- 统一 10 秒 sweep，不建 busy-loop/每包定时器。
- 单个 peer 错误只清该 peer；stop 关闭 listener、sweep 和全部 peer。
- 使用 id 删除，避免 IPOP 的 UDP 显示文本匹配缺陷；所有比较使用严格比较。

**退出条件：** 两来源压力测试无串包；停止后监听端口可立即复用；IPOP UDP/IPv6 已知缺陷逐项有测试。

#### E5 会话共享（2 天）

**状态：Completed（2026-09-03）；真实本地双客户端、实时输出、公开 `write` 输入路径、无历史回放、Telnet IAC/UTF-8/CR 处理及会话关闭清理均有回归。**

**先写失败测试：**

- `ext-port-log-telnet-codec.spec.ts`：跨 chunk IAC、SB/SE、IAC 转义、UTF-8、CRLF/CR-NUL。
- `ext-port-log-share.spec.ts`：只消费 TmEventBus output/status、多客户端实时广播、无历史回放、SessionManagerApi.write、慢客户端、会话关闭和卸载。

**实现：**

- `share-manager.ts` 只依赖冻结契约；输出/status 用 `events.on`，输入用 `sessions.write`。
- 默认 0.0.0.0、无认证、完全可写；欢迎语和正确 Telnet WILL ECHO/SGA。
- 记录客户端元数据和字节；1 MiB 慢客户端缓冲上限。
- Router/SSE 接入 `sessions.list`、`shares.list/start/stop`。

**退出条件：** 两个真实本地 telnet/TCP 客户端能同时看输出并写入假会话；关闭会话后共享端口释放。

#### E6 会话输出日志（2 天）

**状态：Completed（2026-09-03）；默认关闭、仅 output、跨块 ANSI/CR/退格、半行 flush、运行时选项、1 MiB 积压保护及无轮转/无删除均有回归。**

**先写失败测试：**

- `ext-port-log-normalizer.spec.ts`：ANSI 跨块、OSC/CSI、退格、CR 覆盖、CRLF、UTF-8 半字符、时间戳和半行 flush。
- `ext-port-log-session-log.spec.ts`：默认关闭、仅 output、不记录 input、运行时选项、1 MiB 背压、stream error、closed/removed/卸载刷盘。

**实现：**

- `session-log-manager.ts` 只订阅 `output/status`；文件放 `session_logs/`，不用用户 label。
- 不轮转、不删除；UI/RPC 状态包含路径、设置、字节和安全错误。
- stop 用 `stream.end` 等待 finish，不用 destroy。
- Router/SSE 接入 `sessionLogs.list/start/update/stop`。

**退出条件：** 彩色分块输出形成预期纯文本；直接 input 明文不在日志中；末尾无换行内容仍落盘。

#### E7 React 扩展工作区（3 天）

**状态：Completed（2026-09-03）；独立侧栏入口、overlay、RPC/SSE store、映射/共享/日志三页签、CSV/排序、风险确认、明暗 token 与响应式样式已接入。**

**实现顺序：**

1. `rpc.ts` 完成 ClientRequest/Response、错误对象、SSE 自动重连；每次 open/reconnect 先全量拉取。
2. `store.ts` 管可见性、三类 snapshot 和排序；不使用主线 store，不持久化纯显示排序。
3. `PortLogWorkspace.tsx` 注册独立 overlay；先完成关闭/三页签/加载与错误边界。
4. `MappingsTab`：表单、运行卡片、autoStart、排序、CSV 浏览器读写/Blob 下载。
5. `SharesTab`：open 会话列表、监听配置、风险确认、客户端列表和停止。
6. `LogsTab`：应用日志状态、会话日志开关/选项/路径复制/磁盘提示。
7. `port-log.ts` 完成明暗主题、窄屏滚动、状态/表单/对话反馈。

**验证：**

- `ext-port-log-client.spec.ts` 用纯模型/slot mock 测注册、RPC 错误、SSE 重连全量刷新、风险未确认不得 start。
- 浏览器人工验收明暗主题、键盘焦点、aria-label、加载/空/错误状态。
- 扩展 overlay 打开时主线终端仍连接，关闭扩展后主线布局和 xterm 尺寸恢复。

**退出条件：** 用户只通过 UI 完成 intent 三组功能；没有 Agent 操作入口；三处主线挂载以外无主线 diff。

#### E8 联调、审查与交付证据（1.5 天）

**状态：Automated checks completed（2026-09-03）；`pnpm build`、232 项测试、覆盖率阈值（79.86/66.75/81.93/83.95）和 3180 真实 DSH TCP/UDP/CSV/敏感串 smoke 已通过。浏览器环境不可用，明暗主题与风险确认截图待人工验收，因此尚未越过 PR/发布门。**

1. 扩展 `scripts/smoke-e2e.mjs` 会修改主线脚本，违反隔离；因此新建 `scripts/ext-port-log-smoke.mjs`，不碰原脚本。
2. 对活 DSH 使用 3180，绝不占用用户 3080；验证 client.js 200 和插件注入。
3. 完成 TCP/UDP echo、CSV 往返、autoStart 重启、两个共享客户端、慢客户端、会话日志、应用轮转和敏感串扫描。
4. 保存端口映射/共享/日志三页签，以及共享风险确认的明暗主题截图。
5. 按 REVIEW.md 跑缺陷、安全、spec/plan 合规三轮审查；每项发现给文件/行和证据。
6. rebase 最新 main；确认 `git diff origin/main -- src/types` 为空，主线只剩三个挂载点的最小 diff。
7. 最终执行并记录：

~~~text
pnpm build
pnpm test
pnpm vitest run --coverage
DSH_PORT=3180 node scripts/ext-port-log-smoke.mjs
~~~

8. 同步 `spec.md`、`plan.md` 的真实偏离与测试数字；更新 README 的功能入口、外部可写风险和日志磁盘风险。

**退出条件：** 所有自动检查全绿、人工验收通过、无高/中严重度未处理发现，提交 PR 等待两人 review；不得自行合并或发布。

#### 风险与对策

| 风险 | 严重度 | 计划内对策 |
|---|---|---|
| 无认证可写共享暴露设备控制权 | 高（产品已接受） | 用户手动启动、文字警告+勾选、显示监听地址/客户端；不声称安全 |
| 扩展误改冻结契约/主线 | 高 | E0/E8 路径 diff 检查；发现不足走单独契约 PR |
| UDP 来源串包、IPv6 地址族错误 | 高 | 每来源独立 socket；E4 双来源/双栈测试 |
| Socket/订阅/定时器卸载泄漏 | 高 | 单 owner、幂等 stopAll；每里程碑端口复用和 handle 清理测试 |
| 会话日志无限增长占满磁盘 | 中（产品已接受） | 默认关闭、路径/字节显示、明确提示；不偷偷加入轮转 |
| 慢共享客户端或慢磁盘拖垮进程 | 高 | 1 MiB 上限，只断开/停写故障消费者，不阻塞 TmEventBus |
| 日志泄露密码/私钥 | 高 | 不订阅 input；结构化允许字段+敏感键清理；全目录敏感串测试 |
| 扩展 prefix 被主线 /term-manager 抢路由 | 中 | 依赖已验证的 WebServer 最长前缀规则；router 集成测试 |
| SSE 断线造成 UI 状态陈旧 | 中 | 自动重连；每次重连后全量 list/status，再应用增量 |
| 主线并行变化导致合并冲突 | 中 | 只动三个挂载点；实现前/合并前 rebase；测试基线按最新 main 更新 |

#### 计划审批后的第一步

批准后只执行 E0，不直接并行铺开全部代码。E0 证明分支基线、挂载点和契约边界可用后，再按 E1→E8 推进；任何实际文件/接口偏离都在同一提交更新本节。

### feat/remote-file-toolbar 偏离记录（2026-09-09，规则 6）

16. **远端文件面板工具栏对齐本地**：新增"上一级"按钮（复用已有 `up()`）和"跟随终端当前路径"按钮。跟随终端通过 `SftpLike.realpath('.')` → `FileService.remoteCwd()` → `remotes.ts files.remoteCwd` RPC → `remoteFs.goTerminalCwd()` 全链路落地。`goTerminalCwd` 返回 `{ cwd, error }` 供前端 toast 展示成功/失败/已在同路径。`SftpLike` 接口新增 `realpath` 方法（契约改动，`src/transport/types.ts`）。
17. **测试批次 1（P1 主线缺口覆盖）**：新增 5 项测试覆盖 sftp/remotes 错误分支——U-SFTP-RL-01~03（realpath 正常 + NOT_FOUND/DISCONNECTED 错误映射）、U-SFTP-PL-01（place rename fallback：unlink 旧文件再改名）、U-RMT-DL-01（download 流已发送后出错走 `res.destroy`）、U-RMT-WS-01（WS RPC 序列化失败走 catch 回包）。另有 7 项测试覆盖 remoteCwd/goTerminalCwd 全链路（之前提交）。测试基线 457→462 项全绿；sftp 分支 71.76→75.29%，remotes 分支 75.43→76.6%。`vitest.config.ts` 排除纯类型声明文件出覆盖率统计。

### 开放问题（九月）

1. TC 语法真实样例未到——解析器按原型设想语法先做，样例到位后只改 `tc-parser.ts`。
2. `.xlsx` 本期不做（设计方案 3.9）。
3. 浮动编辑器 z-index 与 DSH 模态的冲突——60~90 区间，遇到再让位。

## 证据

- `tests/` 54 文件 / 621 项全绿（2026-09-13）；`pnpm build` 产出 host + client 双半包。
- E2E：`node scripts/run-e2e.mjs` 24/24 全绿（2026-09-13）。
- npm 通道真机挂载：`node scripts/mount-check.mjs` 全绿——隔离 DSH_HOME 里 `dsh plugin add file:<tarball>` + 起真实 `dsh web`，首页 `__DSH_BOOT__` 出现插件行、该行给的产物 URL 返回 200（约 2.0 MB）。
  - **健康判据已更新**：DSH 0.1.2+ 用的是合并 URL `/plugins/??dsh-terminal-manager/client.js&rev=...`，旧的 `/plugins/dsh-terminal-manager/client.js` 现在 **404**；首页裸 URL 401，需用就绪行的一次性 token URL 换 cookie（先回 303）。
- 安装双轨：npm（`dsh plugin --profile web add dsh-terminal-manager@latest`）+ 源码 link。干净克隆下 `pnpm install` **不带任何参数**即可通过（2026-09-13 修复：删掉上游已删除的 `dsh-host-apiproxy` / `dsh-client-runtime`——钉着它们会把传递 peer 链拖成 `ERR_PNPM_NO_MATCHING_VERSION`）。
- 契约迁移（DSH 0.1.2-rc.1 删了上面两个包）：`RpcResult` → `@deepseek-ai/dsh-client-connection`；`ClientContext` → `@deepseek-ai/cordis` 加 `ui-renderer` / `ui-layout` 的 type-only 声明。映射表见 `docs/DHS-0.1.2-rc.1-契约迁移映射.zh.md`。
- 打包：`prepack` 自动构建（杜绝陈旧 `lib/` 被发出去）；tarball 只含 6 个文件、约 604 KB。
- 安装期两个已知坑（都在 README/INSTALL 的常见问题与 `scripts/mount-check.mjs` 里有解法）：全新 profile 缺 `@deepseek-ai/dsh-web-app` bundle（插件等 `webServer` 会 boot 失败）、pnpm 11 拦 `ssh2` 构建脚本（`ERR_PNPM_IGNORED_BUILDS`）。
- 沿用（旧记录）：覆盖率 86.82/76.26/89.7/90.69（阈值 90/80/90/90）。
