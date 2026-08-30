# DSH 终端管理插件（dsh-terminal-manager）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装的终端管理插件：人与 AI **共用同一批远程终端**（SSH / Telnet），AI 能在对话里直接操作设备终端。

**仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager

## 能力

- **SSH / Telnet** 连接（密码 + 密钥；Telnet 完整协议协商，支持真实网络设备登录）；
- 多会话同屏终端（xterm.js），窗口自然填充，支持 1/2/3 列布局和最大化；
- **AI 工具** `tm_connect` / `tm_list` / `tm_send` / `tm_send_all` / `tm_read` / `tm_disconnect`——AI 在对话里调，自主连设备、发命令、拿回结果；
- **命令守卫**：AI 发的危险命令（`rm -rf /` 等）自动拦截；
- 广播：一条命令发多台，逐台独立出结果；
- 连接管理：收藏、最近连接、重连、多窗口布局；
- 纯本地运行，不依赖 MCP。

## 前提条件

- **Node.js** 22+（[下载](https://nodejs.org/)）
- **pnpm** 11+（`npm install -g pnpm`）

## 安装

### 方式一：一键脚本安装（推荐）

先 clone 仓库，然后运行安装脚本：

```bash
# 克隆仓库
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager

# Windows PowerShell
.\scripts\install.ps1

# Linux / macOS
./scripts/install.sh
```

脚本自动完成：检查环境 → 安装依赖 → 构建 → 注册到 DSH `web` profile。

可选参数：
```bash
./scripts/install.sh --profile my-profile      # 指定 profile
.\scripts\install.ps1 -Profile my-profile       # Windows
```

### 方式二：手动安装

```bash
# 1. 克隆并构建
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build

# 2. 安装到 DSH profile（路径替换为你的实际目录）
npx @deepseek-ai/dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"
# Windows PowerShell:
# npx @deepseek-ai/dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"
```

### 方式三：npm 安装（待发布后可用）

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-terminal-manager
```

> 发布到 npm 后即可使用，一行命令搞定。

### 方式四：tgz 手动安装

从 [GitCode Releases](https://gitcode.com/pengpengR/dsh-terminal-manager/releases) 下载 `.tgz` 文件，然后：

```bash
npx @deepseek-ai/dsh plugin --profile web add ./dsh-terminal-manager-0.1.0.tgz
```

### 安装后

```bash
npx @deepseek-ai/dsh web
```

浏览器自动打开 http://127.0.0.1:3080，左侧边栏底部出现「🖥️ 终端」按钮。

## 更新插件

```bash
cd <插件安装目录>
git pull
pnpm install
pnpm build
# 然后重启 DSH
```

## 开发

> 以下内容面向插件开发者，普通用户无需关注。

### 前提条件

- **Node.js** 22+ 或 24+
- **pnpm** 11+（`npm install -g pnpm`）
- **deepseek-harness** 源码检出在**相邻目录**

### 目录结构

```
任意父目录/
├── deepseek-harness/        # git clone https://github.com/deepseek-ai/deepseek-harness.git
└── dsh-terminal-manager/    # git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
```

> **⚠️ 目录名必须是 `dsh-terminal-manager`**（与 package.json 的 `name` 一致）。pnpm 在某些平台上会用目录名做包别名，名字不对会导致 `dsh.bundle` 检测失败。

### 安装与构建

```sh
cd dsh-terminal-manager
pnpm install          # 安装依赖（link: 指向相邻的 deepseek-harness）
pnpm build            # 产出 lib/index.js（host 半）+ lib/client.js（浏览器半）
pnpm test             # 167 项 vitest（模拟设备，不碰真设备）
```

### 本地调试

```sh
# 在 deepseek-harness 目录下创建开发 profile（只需一次）
cd ../deepseek-harness
pnpm dsh plugin --profile tm-dev add "dsh-terminal-manager@link:../dsh-terminal-manager"

# 启动调试
pnpm dsh --profile tm-dev --port 3180 --no-open
# 浏览器开 http://127.0.0.1:3180
```

> **为什么用 `dsh-terminal-manager@link:` 而不是直接写路径？**
> pnpm 对本地路径有时用目录名做包别名（而非 package.json 里的 `name`）。如果别名不匹配，DSH 检测不到 `dsh.bundle` 声明，插件不会加载。显式指定包名可以避免这个问题。

### 模拟设备

本地联调无需真实设备：

```sh
node scripts/mock-device.mjs 2323   # 起一台模拟路由器 CLI
node scripts/mock-device.mjs 2324   # 第二台（测多会话/广播）
```

### 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| `dsh.bundle` 检测失败，插件不加载 | 用了目录名做包别名 | 用 `"dsh-terminal-manager@link:../dsh-terminal-manager"` 语法 |
| `Cannot find package 'ssh2'` | 重命名目录后符号链接断了 | 在插件目录重新 `pnpm install` |
| `profile "xxx" does not exist` | 用了不存在的 profile | 用 `web` 或先创建 profile |
| 启动后终端按钮不出现 | 插件没加载 | 检查 `__DSH_BOOT__` 里有没有 `dsh-terminal-manager` |

## 架构

双半包：host 半（DSH 进程内，连接/会话/工具/路由）+ 浏览器半（xterm + WS 客户端 + 插槽挂载）。
完整设计见 `spec.md`；进度/待办/偏离见 `plan.md`；命令/坑/约定见 `CLAUDE.md`。

## 已知限制（MVP）

- **凭据明文存储**：连接配置（含密码/密钥）以明文 JSON 存于本地，文件权限尽力限为仅本人。后续接 DSH 凭据服务。
- **SSH 主机密钥不严格校验**：接受任意主机密钥并在界面显示指纹。后续做「首次信任」（TOFU）。
- **无串口**：SSH + Telnet only。串口是交付后第一个扩展项（传输层接口已留接缝）。
- **无文件传输**（SFTP）、无审计录屏、无多用户协作。
- **WS 信任栅栏仅 loopback**：非 loopback 部署（0.0.0.0 + trustedHosts）的 WS 数据面需后续放宽。
- **完成判定**：静默 500ms / 提示符正则（可选）/ 超时 30s 三重；参数按连接可调。慢设备可能误判，用 `tm_read` 复查。

## 许可证

[MIT](LICENSE)。
