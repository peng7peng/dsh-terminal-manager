# DSH 终端管理插件（dsh-terminal-manager）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装的终端管理插件：人与 AI **共用同一批远程终端**（SSH / Telnet），AI 能在对话里直接操作设备终端。

> 本版本基于 **DeepSeek Harness 0.1.2-rc.1** 开发。

**仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager

## 能力

### 连接与终端

- **SSH / Telnet** 连接（密码 + 密钥；Telnet 完整协议协商，支持真实网络设备登录）；
- 多会话同屏终端（xterm.js），窗口自然填充，支持 1/2/3 列布局和最大化；
- **AI 工具** `tm_connect` / `tm_list` / `tm_send` / `tm_send_all` / `tm_read` / `tm_disconnect` / `tm_upload` / `tm_download`——AI 在对话里调，自主连设备、发命令、拿回结果、在工作区与 SSH 设备间传文件；
- **命令守卫**：AI 发的危险命令（`rm -rf /` 等）自动拦截；
- 广播：一条命令发多台，逐台独立出结果；
- 连接管理：收藏、最近连接、重连、多窗口布局；

> 📸 *截图位：多会话同屏终端*

### 文件管理

- **本地文件面板**（工作区底部）：浏览、换根目录、双击用内置编辑器打开；
- **远端文件面板**（本地面板上方）：切换在线 SSH 会话浏览设备文件，单文件上传 / 下载（另存为或下载到工作区），同名冲突可选覆盖 / 跳过 / 重命名，传输有行内进度条；本地面板 ↔ 远端面板联动（选中即传），OS 拖拽文件直传，编辑器当前文件一键上传；

> 📸 *截图位：本地 + 远端文件面板联动*

### 编辑器

- **浮动编辑器**（CodeMirror 6）：多标签、语法高亮（sh / py / json / md）、Ctrl+S 保存、可拖可缩可最小化；
- **CSV / TSV 表格渲染**：打开 `.csv` / `.tsv` 文件时自动以表格形式展示（首行作表头、固定不滚动），支持引号包裹字段、引号内换行、BOM 头自动去除；工具栏可一键切换「表格」和「文本」视图；超过 5000 行时只渲染前 5000 行并提示切到文本查看完整内容；

> 📸 *截图位：CSV 表格渲染 + 视图切换*

- **TC 脚本执行**：`.txt` 脚本里 `##>0` / `##>12` 指定目标终端编号（TC0、TC1… = 活跃会话顺序，拖动列表即切换），一键按映射逐条打到对应终端，执行前确认映射，执行后汇总条逐项 ✓/✗；
- **发送选中**：`.md` / `.txt` 里选几行，勾选终端后逐条发送；

> 📸 *截图位：TC 脚本执行 + 汇总条*

### 端口映射

- **TCP / UDP 端口映射**：配置持久化、独立启停、随插件启动、CSV 导入/导出、列表排序和实时流量统计；

> 📸 *截图位：端口映射列表 + 流量统计*

### 会话共享

- **会话共享**：把已打开的 SSH/Telnet 会话通过 TCP 共享给其他客户端，实时收发终端数据；支持设置最大客户端数，超限自动拒绝新连接；

> 📸 *截图位：会话共享*

### 日志

- **运行日志**：插件运行日志按 5 MiB、最多 5 个文件轮转；
- **会话日志**：设备输出日志可按会话启停，按连接名 + 时间戳自动命名；

> 📸 *截图位：会话日志面板*

- 纯本地运行，不依赖 MCP。

## 文件访问范围

本地文件面板与编辑器只能读写**当前根目录及其子目录**：默认根 = 启动 DSH 时的当前目录（可在 `cordis.yml` 里给本插件配 `workspaceRoot`），面板里「换目录」可临时切换（记在浏览器本地）。越界路径（含符号链接指向根外）一律拒绝。切换根目录即视为授权该目录。

**远端文件**（仅 SSH 会话，走 SFTP）：远端无树根概念，面板浏览到的整个设备文件系统与 SSH 终端同等权限；Telnet 会话不支持文件传输（面板会提示）。上传到设备先写远端临时文件（`.tm-partial-*`）成功后改名，下载到工作区同样有半成品保护——中断不留半个文件。

## 前提条件

- **DeepSeek Harness 0.1.2-rc.1**（`dsh web` 能正常跑起来）
- **Node.js** 22+（[下载](https://nodejs.org/)）
- **pnpm** 11+（`npm install -g pnpm`）——DSH 用它装插件；源码安装时也用它装依赖

## 安装

### 方式一：npm 安装（推荐，普通用户）

```bash
dsh plugin --profile web add dsh-terminal-manager@latest
```

装完**硬刷新浏览器**（Ctrl/Cmd + Shift + R）即可看到侧边栏底部的「🖥️ 终端」按钮。DSH 对 client 改动是热加载的，通常不需要重启。

<details>
<summary><b>dsh 命令不可用 / 想装到别的 profile</b></summary>

```bash
# dsh 命令不在 PATH 里时用 npx 兜底
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-terminal-manager@latest

# 装到其他 profile
dsh plugin --profile <你的profile> add dsh-terminal-manager@latest
```

</details>

<details>
<summary><b>更新</b></summary>

```bash
dsh plugin --profile web add dsh-terminal-manager@latest
```

也可以把 `~/.dsh/profiles/web/package.json` 里的版本号改高再 `pnpm install`。改完硬刷新浏览器即可。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `ERR_PNPM_IGNORED_BUILDS: ssh2@1.17.0` | pnpm 11 拦了 ssh2 的构建脚本。① 省事做法：在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里写 `allowBuilds: {ssh2: false, cpu-features: false}`（ssh2 的原生绑定只是可选加速，纯 JS 回退完全够用），再装一次就过；② 或在 profile 目录跑 `pnpm approve-builds --all`，然后重跑安装命令（若提示 gyp 编译失败，属正常，ssh2 会回退纯 JS） |
| 启动报 `plugin tree failed to load`，并显示 `dsh-terminal-manager: pending (waiting for service: webServer)` | 装插件之前没跑过 `dsh web`，新建 profile 的 `dsh.profile.bundles` 里只有 `@deepseek-ai/dsh-base` + 本插件，缺 `@deepseek-ai/dsh-web-app`（`webServer` 由它提供）。解决：在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里补上 `"@deepseek-ai/dsh-web-app"`；或删掉该 profile 目录、先跑一次 `dsh web` 再装 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不到 24 小时。等 24h，或直接重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`） |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web`，让它初始化 `~/.dsh/profiles/web` |
| 装完看不到终端按钮 | 先硬刷新（Ctrl/Cmd + Shift + R）；仍没有就 F12 看控制台报错，并确认 `~/.dsh/profiles/web/node_modules/` 下有 `dsh-terminal-manager` |
| 提示 `dsh: command not found` | 用上面的 npx 兜底命令，或先安装 DSH |
| 连不上设备 | 插件只做终端；确认目标主机可达、端口开放（`ping` / `nc -zv <host> <port>`），SSH 服务在跑 |

</details>

### 方式二：源码安装（开发者）

要改代码、调试本地改动时用。DSH 那侧的依赖（`@deepseek-ai/*`）**照样从 npm 取**，不需要本地准备 DSH 源码树。

```bash
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build
dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"
# Windows PowerShell:
# dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"
```

<details>
<summary><b>源码安装的更新与验证</b></summary>

```bash
cd <插件安装目录>
git pull
pnpm install      # 依赖有变动时才需要
pnpm build        # 必须重新构建：profile 用的是 lib/ 里的产物
# 然后硬刷新浏览器（client 改动热加载；host 半改动需重启 DSH）
```

仓库自带验证手段：

```bash
pnpm test                     # vitest，当前 54 个文件 / 621 项
node scripts/run-e2e.mjs      # 24 个 E2E 场景，自动拉起 mock 设备 + DSH 服务
```

</details>

## 许可证

[MIT](LICENSE)。

编辑器窗口的拖动 / 缩放、CodeMirror 主题、路径安全校验与目录列表改编自 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT），对应文件头已注明来源。
