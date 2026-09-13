# DSH Terminal Manager 安装指南

> 🖥️ SSH/Telnet 多会话终端管理器 —— DSH 插件
>
> **仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager
> **npm 包**：https://www.npmjs.com/package/dsh-terminal-manager

---

## 📋 前提条件

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| DeepSeek Harness | 0.1.2-rc.1 | `dsh web` 能正常跑起来 |
| Node.js | ≥ 22 | [下载](https://nodejs.org/) |
| pnpm | ≥ 11 | `npm install -g pnpm`；DSH 用它装插件 |

检查版本：

```bash
node --version    # 应显示 v22.x 或更高
pnpm --version    # 应显示 11.x 或更高
```

---

## 🚀 安装

### 方式一：npm 安装（推荐）

不需要 clone 仓库、不需要构建，一行命令：

```bash
dsh plugin --profile web add dsh-terminal-manager@latest
```

装完**硬刷新浏览器**（Ctrl/Cmd + Shift + R），左侧边栏底部出现「🖥️ 终端」按钮。

<details>
<summary><b>dsh 命令不可用</b></summary>

```bash
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-terminal-manager@latest
```

</details>

<details>
<summary><b>装到其他 profile</b></summary>

```bash
dsh plugin --profile <你的profile> add dsh-terminal-manager@latest
```

注意：profile 必须已经存在（先用 `dsh web --profile <你的profile>` 跑一次让它初始化）。

</details>

### 方式二：源码安装（开发者）

要改代码、调试本地改动时用。DSH 那侧的依赖照样从 npm 取，不需要本地准备 DSH 源码树。

```bash
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build

# 挂到 DSH profile
# Linux / macOS:
dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"
# Windows PowerShell:
dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"
```

> **为什么用 `@link:`**：profile 里存的是指向你克隆目录的符号链接，所以改完代码只要 `pnpm build`，再硬刷新浏览器就是新版本。

仓库自带验证手段：

```bash
pnpm test                     # vitest：54 个文件 / 621 项
node scripts/run-e2e.mjs      # 24 个 E2E 场景（自动拉起 mock 设备 + DSH 服务）
node scripts/mount-check.mjs  # npm 通道真机挂载验证（隔离 DSH_HOME，不碰你的 ~/.dsh）
```

---

## ▶️ 启动与验证

```bash
dsh web
```

1. 浏览器打开 http://127.0.0.1:3080（或 DSH 打印的端口）；
2. 左侧边栏底部应出现「🖥️ 终端」按钮，点击展开右侧终端工作区；
3. 点「连接」面板的 **+**，填 SSH/Telnet 信息试连一台设备。

判断插件是否真的加载了：

```bash
# 插件产物能被访问（200）
curl -I http://127.0.0.1:3080/plugins/dsh-terminal-manager/client.js

# profile 里确实装上了
ls ~/.dsh/profiles/web/node_modules/ | grep terminal-manager
```

---

## 🔄 更新插件

**npm 安装的：**

```bash
dsh plugin --profile web add dsh-terminal-manager@latest
# 然后硬刷新浏览器（Ctrl/Cmd + Shift + R）
```

**源码安装的：**

```bash
cd <插件安装目录>
git pull
pnpm install      # 依赖有变动时才需要
pnpm build        # 必须重新构建：profile 用的是 lib/ 里的产物
# 然后硬刷新浏览器（client 改动热加载；host 半改动需重启 DSH）
```

---

## 🗑️ 卸载插件

```bash
dsh plugin --profile web remove dsh-terminal-manager
```

源码安装的，卸载完可以再删掉克隆目录。

---

## 🎮 基本使用

### 连接设备

1. 点右侧「连接」面板的 **+** 按钮
2. 选择协议（SSH / Telnet）
3. 填写连接信息：
   - **主机**：IP 地址或域名
   - **端口**：SSH 默认 22，Telnet 默认 23
   - **用户名 / 密码**（SSH）或 **Telnet 模式**
4. 点「连接」

### 收藏连接

- 填好连接信息后点「⭐ 收藏」，保存到收藏列表
- 下次直接从收藏列表点连接

### 多窗口管理

- 支持 1/2/3 列布局切换
- 可拖动分隔条调整聊天 / 终端宽度
- 支持最大化单个终端窗口

### 广播命令

- 底部广播栏可向多个会话同时发送命令
- 选择目标会话或「全部」，输入命令后回车或点发送

### 让 AI 一起用

插件给 AI 开放了工具：`tm_connect` / `tm_list` / `tm_send` / `tm_send_all` / `tm_read` / `tm_disconnect` / `tm_upload` / `tm_download`。在对话里直接说「连一下 192.168.1.1」即可，人与 AI 共用同一批终端会话。

---

## 🐛 常见问题

| 现象 | 原因与解决 |
|---|---|
| 报 `ERR_PNPM_IGNORED_BUILDS: ssh2@1.17.0` | pnpm 11 拦了 ssh2 的构建脚本。省事做法：在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里写 `allowBuilds: {ssh2: false, cpu-features: false}`（纯 JS 回退够用），再装一次；或者在 profile 目录跑 `pnpm approve-builds --all` 后重跑安装命令（提示 gyp 编译失败属正常） |
| 启动报 `plugin tree failed to load`，并显示 `dsh-terminal-manager: pending (waiting for service: webServer)` | 装插件前没跑过 `dsh web`，新建 profile 缺 `@deepseek-ai/dsh-web-app` 这个 bundle（`webServer` 由它提供）。在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里补上 `"@deepseek-ai/dsh-web-app"` 即可 |
| 报 `minimum release age` / 版本不足 24h | 装的版本发布不到 24 小时。等 24h，或直接重跑一次 |
| 报「找不到 profile 目录」/ `profile "xxx" does not exist` | 先跑一次 `dsh web`（可加 `--profile`）让它初始化 profile |
| 装完看不到终端按钮 | 先硬刷新（Ctrl/Cmd + Shift + R）；仍没有就 F12 看控制台报错，并确认 profile 的 `node_modules/` 下有 `dsh-terminal-manager` |
| 提示 `dsh: command not found` | 用 npx 兜底命令，或先安装 DSH |
| 连接失败提示 `Session not found` | 通常是网络：先 `ping <host>`，再确认端口开放（`nc -zv <host> <port>`），最后查防火墙 |
| SSH 连接超时 | 确认 SSH 服务在跑、用户名/密码/密钥正确；可在高级设置里调大超时 |
| 下载 / 上传失败 | Telnet 会话不支持文件传输（面板会提示）；远端路径要写绝对路径 |
| 页面出现两个终端入口 | 同一 profile 被装了两次（例如既有 npm 版又有 `@link:` 版）：`dsh plugin --profile web remove dsh-terminal-manager` 后重装一种 |

---

## 📞 获取帮助

- **问题反馈**：[GitCode Issues](https://gitcode.com/pengpengR/dsh-terminal-manager/issues)
- **讨论区**：[GitCode Discussions](https://gitcode.com/pengpengR/dsh-terminal-manager/discussions)
- **上游 DSH**：https://github.com/deepseek-ai/deepseek-harness

---

## 📄 许可证

[MIT](LICENSE)
