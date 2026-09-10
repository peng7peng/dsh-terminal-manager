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

- **Node.js** 22+（[下载](https://nodejs.org/)）
- **pnpm** 11+（`npm install -g pnpm`）
- **DeepSeek Harness** 0.1.2-rc.1

## 安装

```bash
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build
dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"
# Windows PowerShell:
# dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"
```

安装完成后运行 `dsh web`，浏览器打开 http://127.0.0.1:XXXX，左侧边栏底部出现「🖥️ 终端」按钮。

## 更新插件

```bash
cd <插件安装目录>
git pull
pnpm install
pnpm build
# 然后重启 DSH
```

## 许可证

[MIT](LICENSE)。

编辑器窗口的拖动 / 缩放、CodeMirror 主题、路径安全校验与目录列表改编自 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT），对应文件头已注明来源。
