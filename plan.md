# DSH Terminal Manager — 构建计划

- 派生自：`spec.md`（Approved，commit 见 git 历史）
- 状态：草稿（Draft）
- 日期：2026-08-25
- 修订：2026-08-25 按产品负责人要求，插入「方案讲解 + GUI 方案选型」里程碑（M1）

## 改动文件

全部为**新建**（仓库目前只有 SDLC 产物）。

### 方案与原型（M1 产物）

| 文件 | 内容 |
|---|---|
| `docs/solution.zh.md` | 给人看的方案设计：背景、目标、架构总览、关键取舍、风险与排期；含 mermaid 图（架构图、人工连接时序、Agent 发命令时序、会话状态机） |
| `prototypes/gui-a.html`、`gui-b.html`、`gui-c.html` | 三个可交互 GUI 原型：浏览器直接打开即可点选体验（连接/断开、终端模拟输出、页签切换、广播），三种视觉风格 |

### 仓库脚手架

| 文件 | 内容 |
|---|---|
| `package.json` | 双 manifest：`dsh.bundle.patch` → `./cordis.patch.yml`；`dsh.client`（platform web，inject 参照 `ui-cordis`）；`prepare` 脚本自包含构建（git 安装场景） |
| `cordis.patch.yml` | host 半插入行（插件名 + 默认 config） |
| `tsdown.config.ts` / `tsconfig.json` | host 半转译到 `lib/`；参照 turtle-ui 的「直接转译、不依赖 monorepo 上下文」模式 |
| `vitest.config.ts` | 单测 + 集成配置 |
| `.gitignore`、`README.zh.md` | 常规；README 含安装/开发/已知限制（明文凭据、主机密钥策略） |

### host 半（`src/`）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 入口：`name/inject/apply`——装配 ConnectionStore、SessionManager、`tm_*` 工具、`termManager` remotes、`/term-io` WS 路由；`ctx.effect` 清理 |
| `src/config.ts` | 插件 Config schema（数据目录、默认超时/静默期、缓冲上限） |
| `src/connection-store.ts` | 连接配置 CRUD + JSON 持久化（0600）+ 校验 |
| `src/wait-policy.ts` | 完成判定三重机制（静默期/提示符正则/超时）纯函数状态机 |
| `src/transport/types.ts` | 传输层内部接口（write/resize/close/onData/onClose/onError + hostKey 指纹事件） |
| `src/transport/ssh.ts` | ssh2 shell 通道；密码/密钥认证；`readyTimeout`；主机密钥指纹采集 |
| `src/transport/telnet.ts` | `net.connect` 裸 TCP 透传 |
| `src/session-manager.ts` | 会话状态机、环形缓冲（1MiB）、订阅、`connect/disconnect/send/broadcast/read/sendAndWait/list`；独占发送 |
| `src/tools.ts` | `tm_connect/tm_list/tm_send/tm_send_all/tm_read/tm_disconnect`（defineTool）+ `ctx.systemPrompt.section` |
| `src/remotes.ts` | `termManager` typert remotes：`connections.*` 与 `sessions.*` 控制面 |
| `src/ws-io.ts` | `/term-io` WebSocket upgrade 路由 + 帧协议 + 信任栅栏（仿 `isTrustedApiRequest`） |

### 浏览器半（`client/`）

| 文件 | 职责 |
|---|---|
| `client/index.ts` | `apply(ClientContext)`：locale 注册、`sidebar.footer.action` 入口、工作区面板挂载 |
| `client/TerminalPanel.tsx` | 双页签外壳（终端/连接）+ 与 `ctx.remote.termManager` 的状态同步 |
| `client/ConnectionsTab.tsx` | 连接卡片列表 + 新建/编辑表单 + 连接/断开按钮 |
| `client/TerminalsTab.tsx` | 终端网格 + 广播栏（目标选择 + 发送） |
| `client/TermView.tsx` | xterm.js 封装：WS attach/输入/回放/自适应尺寸（@xterm/addon-fit） |
| `client/ws.ts` | `/term-io` 客户端：单连接多路复用、断线重连、帧分发 |
| `client/*.module.css` | CSS Modules 样式，**视觉以 M1 选定的原型为基准** |

### 测试（`tests/`）

`wait-policy.spec.ts`、`connection-store.spec.ts`、`session-manager.spec.ts`、`transport.spec.ts`（进程内 `ssh2` Server + 本地 TCP echo）、`tools.spec.ts`（经测试上下文调用 `tm_*`）。

### SDLC 产物

`CLAUDE.md` 的「命令」一节随脚手架落地后改为真实命令；`plan.md` 若实施中偏离，同提交更新。

## 工作顺序

**M0 — 脚手架与垂直切片（最高风险先行）**
1. 初始化 `package.json` 双 manifest、tsdown、vitest、lint（oxlint 规则参照 deepseek-harness）。
2. 依赖解析：`@deepseek-ai/*` 以 `link:` 指向相邻 `../deepseek-harness/packages/*` 检出，保证与框架当前版本严格一致；`ssh2`、`@xterm/*` 走 npm。
3. 最小 host 半（`apply` 打印加载日志）+ 最小浏览器半（`sidebar.footer.action` 注册一个按钮，点击弹出写有「hello」的面板）。
4. 构建产物；`dsh plugin --profile tm-dev add ./terminal-manager`；`dsh --profile tm-dev` 启动，确认按钮与面板出现在页面上。
5. **Go/No-Go**：浏览器半能显示 → 按计划继续；不能 → 排查 `dsh.client` 装配（对照 `ui-cordis` manifest 逐项核对），仍不通则升级讨论备用投递方案，**不硬闯**。

**M1 — 方案讲解 + GUI 原型选型（产品负责人参与）**
1. 写 `docs/solution.zh.md`：面向人的完整方案说明，含 mermaid 图——整体架构图、人点击连接的时序图、Agent 发命令取结果的时序图、会话状态机图、数据面帧流图。
2. 做三个可交互原型 `prototypes/gui-{a,b,c}.html`（浏览器直接打开即点即用，模拟数据）：
   - A：**深色紧凑**——高密度终端网格，运维风；
   - B：**明亮卡片**——宽松卡片布局，轻快直观；
   - C：**状态中枢**——顶部连接状态总览条 + 紧凑网格，强调一眼看全局。
   三个原型都覆盖核心交互：连接页签的增删改连、终端页签的网格/广播、模拟输出流动。
3. 产品负责人体验后**选定一个**（可提混合意见），选型结论记录进 git 提交，作为 M4 界面实现的视觉基准；未选定前 M4 不开工。

**M2 — 连接核心（host 半，无 UI）**
1. `wait-policy` + `connection-store`（含持久化与 0600）+ 单测。
2. `transport/ssh` + `transport/telnet`；`transport.spec.ts` 用进程内 ssh2 Server / TCP echo 跑通连接、收发、断连、错误路径。
3. `session-manager`：状态机、环形缓冲、订阅、独占发送、`sendAndWait`；单测覆盖并发与忙碌路径。
4. 验收：`pnpm test` 全绿；无 UI 也能用脚本走通「保存连接 → connect → sendAndWait → read → disconnect」。

**M3 — Agent 工具面**
1. `tools.ts`：六个 `tm_*` 按 spec 表格实现；`presentCall/presentResult` 卡片；`systemPrompt.section` 指引。
2. `remotes.ts`：`termManager` 控制面（浏览器半 M4 会消费，先落地便于联调）。
3. `tools.spec.ts`：经测试上下文注册与调用，断言 schema、返回、取消（`exec.signal`）、错误形态。
4. 验收：在真实 `dsh` 会话里让 Agent 调 `tm_connect/tm_send`（对 M2 的进程内测试服务器），输出完整回传。

**M4 — 数据面 + GUI（按选定原型实现）**
1. `ws-io.ts`：`/term-io` upgrade 路由 + 帧协议 + 信任栅栏；`attach` 回放缓冲尾部；单测走内存 socket。
2. `client/ws.ts` + `TermView.tsx`：单会话渲染、键入回传、`resize`。
3. `TerminalPanel/ConnectionsTab/TerminalsTab`：双页签、连接表单、状态徽标、广播栏；**视觉以 M1 选定原型为基准**。
4. 真实启动截图验证三个画面：连接页配置两条连接；终端页双会话实时输出；广播后双终端回显。
5. 验收：截图与选定原型比对；`details` 栏收起/展开、切换聊天会话后重新展开，会话与输出无丢失。

**M5 — 收尾与验收演示**
1. 广播忙碌路径、断连重连、错误凭据等边界打磨；文档（README 已知限制、CLAUDE.md 补「Agent 容易犯的错」）。
2. 按 spec「验收演示」三幕走一遍真实流程，截图/输出存档。
3. 写 20+ 条 eval 用例进 `evals/`（Test 阶段种子）。

## 风险

| 风险 | 对策 |
|---|---|
| 外部包浏览器半装配不被宿主消费（最高风险） | M0 垂直切片先行，Go/No-Go 门；备用方案升级讨论而非硬闯 |
| `ssh2` 在 Windows 上的可选原生加密依赖安装失败 | 用其纯 JS 回退路径；本地验证一次安装 |
| 框架开发者预览破坏性变更 | 依赖用 `link:` 锁相邻检出；每个里程碑结束跑一遍真实启动冒烟 |
| `@xterm/*` 进客户端 bundle 的兼容性 | M4 第一步先做最小渲染冒烟，再铺组件 |
| 完成判定对慢设备误判 | 参数按连接可调；`waitReason` 暴露给 Agent；M5 联调真实设备微调 |
| 明文凭据意外泄漏到日志/工具返回 | 传输层与工具层返回类型中不含凭据字段；单测断言错误消息不含密码 |
| GUI 选型反复 | 原型阶段把选择前置（改动成本≈0 的三个 HTML）；选定后写入提交作为基准 |

## 证据

- `docs/solution.zh.md` + 三个原型 + 选型提交记录（M1）；
- `tests/wait-policy.spec.ts`：三重判定各自触发 + 优先级（提示符 > 静默 > 超时）+ 超时兜底；
- `tests/transport.spec.ts`：进程内 ssh2 Server 密码/密钥两路认证、收发、断连；TCP echo 透传；
- `tests/session-manager.spec.ts`：状态机迁移、独占发送报 `busy`、缓冲分页、广播逐会话独立；
- `tests/tools.spec.ts`：六工具 schema 与返回、`exec.signal` 取消、错误凭据报错不含密码；
- 截图证据（M4/M5）：连接页、双终端页、广播回显、Agent 调用回传画面，与选定原型比对。

## 验证

- `pnpm build` 无错误；`pnpm test` 全绿；`pnpm lint` 零警告——每次报告完成前粘贴输出。
- 真实启动冒烟：`dsh --profile tm-dev` → 浏览器打开 → 侧边栏按钮可见（M0 起每个里程碑结束跑一次）。
- 验收演示三幕（spec「验证计划」）全程输出存档。

## 并行化

- **单一实现主线**（M0→M5 强依赖链），不开多会话改代码，避免冲突与评审超载。
- 命名子代理仅用于验证：`verifier`（跑构建/测试/启动截图，报告证据）在 M0/M4/M5 各用一次；每次派发说明原因，报告界限明确（跑了什么、看到什么、没查什么）。
- M1 的三个原型相互独立，若届时评审带宽允许可并行产出，但默认单线顺序完成，保证风格可控。
