# DSH Terminal Manager 安装指南

> 🖥️ SSH/Telnet 多会话终端管理器 —— DSH 插件
>
> **仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager

---

## 📋 前提条件

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | ≥ 22 | [下载](https://nodejs.org/) |

检查版本：
```bash
node --version    # 应显示 v22.x 或更高
```

---

## 🚀 安装方式

提供四种安装方式，按推荐顺序排列。

### 方式一：一键脚本（推荐）

脚本自动下载插件并安装到 DSH，无需手动操作：

**Windows (PowerShell):**
```powershell
irm https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.ps1 | iex
```

**Linux / macOS:**
```bash
curl -fsSL https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.sh | bash
```

> 也可先 clone 仓库到本地，然后执行 `./scripts/install.sh` 或 `.\scripts\install.ps1`。

脚本会自动完成：
1. 检查 Node.js 环境
2. 下载插件 tgz（或改用 git 安装）
3. 执行 `dsh plugin add` 安装到 `web` profile
4. 自动注册到插件列表

### 方式二：npm 安装（待发布后可用）

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-terminal-manager
```

这是最简单的方式——一行命令，无需下载。发布到 npm 后即可使用。

### 方式三：从 GitCode 直接安装

```bash
npx @deepseek-ai/dsh plugin --profile web add git+https://gitcode.com/pengpengR/dsh-terminal-manager.git
```

> **注意**：首次 git 安装时 pnpm ≥10 会阻止构建脚本。请按 `dsh` 的提示，在 profile 的 `pnpm-workspace.yaml`（位于 `~/.dsh/profiles/web/`）中添加：
> ```yaml
> allowBuilds:
>   dsh-terminal-manager: true
> ```
> 然后重新执行安装命令。

### 方式四：手动 tgz 安装

**第 1 步：下载插件**

从 [GitCode Releases](https://gitcode.com/pengpengR/dsh-terminal-manager/releases) 下载 `dsh-terminal-manager-0.1.0.tgz`，或命令行下载：

```bash
# Linux / macOS
curl -L -o dsh-terminal-manager-0.1.0.tgz \
  https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.1.0/dsh-terminal-manager-0.1.0.tgz
```

```powershell
# Windows PowerShell
Invoke-WebRequest -Uri "https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.1.0/dsh-terminal-manager-0.1.0.tgz" `
  -OutFile "dsh-terminal-manager-0.1.0.tgz"
```

**第 2 步：安装插件**

```bash
npx @deepseek-ai/dsh plugin --profile web add ./dsh-terminal-manager-0.1.0.tgz
```

这个命令会：
- 首次运行时自动初始化 DSH 环境（创建 `~/.dsh` 目录）
- 安装插件到 `web` profile
- 自动注册到插件列表（无需手动编辑配置文件）

---

## ▶️ 启动

```bash
npx @deepseek-ai/dsh web
```

浏览器会自动打开 http://127.0.0.1:3080

左侧边栏底部会出现「🖥️ 终端」按钮，点击即可使用。

---

## ✅ 验证安装

1. **启动 DSH**：
   ```bash
   npx @deepseek-ai/dsh web
   ```

2. **打开浏览器**：访问 http://127.0.0.1:3080

3. **检查插件加载**：
   - 左侧边栏应出现「🖥️ 终端」按钮
   - 点击后右侧应展开终端工作区

---

## 🎮 基本使用

### 连接设备

1. 点击右侧「连接」面板的 **+** 按钮
2. 选择协议（SSH / Telnet）
3. 填写连接信息：
   - **主机**：IP 地址或域名
   - **端口**：SSH 默认 22，Telnet 默认 23
   - **用户名/密码**（SSH）或 **Telnet 模式**
4. 点击「连接」

### 收藏连接

- 填写好连接信息后，点击「⭐ 收藏」保存到收藏列表
- 下次可直接从收藏列表点击连接

### 多窗口管理

- 支持 1/2/3 列布局切换
- 可拖动分隔条调整聊天/终端宽度
- 支持最大化单个终端窗口

### 广播命令

- 底部广播栏可向多个会话同时发送命令
- 选择目标会话或「全部」
- 输入命令后按回车或点击发送

---

## 🔄 更新插件

```bash
# 下载新版本 tgz 后
npx @deepseek-ai/dsh plugin --profile web remove dsh-terminal-manager
npx @deepseek-ai/dsh plugin --profile web add ./dsh-terminal-manager-0.2.0.tgz
```

如果通过 npm 安装：
```bash
npx @deepseek-ai/dsh plugin --profile web update dsh-terminal-manager
```

---

## 🗑️ 卸载插件

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-terminal-manager
```

---

## 🐛 常见问题

### Q: 启动后看不到终端按钮？

**A:** 检查以下几点：
1. 浏览器控制台是否有报错（F12 打开开发者工具）
2. 确认插件安装成功：`ls ~/.dsh/profiles/web/node_modules/` 应有 `dsh-terminal-manager`
3. 重启 DSH 服务

### Q: 连接失败提示 "Session not found"？

**A:** 这通常是网络问题：
1. 确认目标主机可达：`ping <host>`
2. 确认端口开放：`telnet <host> <port>` 或 `nc -zv <host> <port>`
3. 检查防火墙设置

### Q: SSH 连接超时？

**A:**
1. 检查 SSH 服务是否运行
2. 确认用户名/密码/密钥正确
3. 尝试增加超时时间（高级设置里配置）

### Q: 提示 profile "xxx" does not exist？

**A:** 使用默认 profile：
```bash
npx @deepseek-ai/dsh web
```
不要用 `--profile tm-dev` 或其他自定义 profile，除非你已创建。

### Q: git 安装时报 allowBuilds 错误？

**A:** 编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`，添加：
```yaml
allowBuilds:
  dsh-terminal-manager: true
```
然后重新执行安装命令。

---

## 📞 获取帮助

- **问题反馈**：[GitCode Issues](https://gitcode.com/pengpengR/dsh-terminal-manager/issues)
- **讨论区**：[GitCode Discussions](https://gitcode.com/pengpengR/dsh-terminal-manager/discussions)

---

## 📄 许可证

[MIT](LICENSE)
