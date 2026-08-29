# DSH Terminal Manager 安装指南

> 🖥️ SSH/Telnet 多会话终端管理器 —— DSH 插件
> 
> **仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager

---

## 📋 前提条件

在开始安装之前，请确保你的环境满足以下要求：

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | ≥ 22.19.0 或 ≥ 24.0.0 | 运行时环境 |
| pnpm | ≥ 11.7.0 | 包管理器 |
| DSH (deepseek-harness) | 最新版本 | 插件宿主框架 |

### 检查版本

```bash
node --version    # 应显示 v22.x 或 v24.x
pnpm --version    # 应显示 11.x
```

---

## 🚀 快速安装（一键脚本）

**脚本会自动完成以下操作：**
1. 检查 Node.js 环境
2. 初始化 DSH（首次运行时）
3. 下载插件
4. 安装并注册到 Profile

### Windows (PowerShell)

```powershell
# 一键安装（自动下载 DSH + 插件）
irm https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.ps1 | iex
```

或手动下载脚本后执行：

```powershell
# 从本地 tgz 安装
.\scripts\install.ps1 -PluginPath ".\dsh-terminal-manager-0.0.1.tgz"

# DSH 已装好，只装插件
.\scripts\install.ps1 -SkipDsh
```

### Linux / macOS (Bash)

```bash
# 一键安装（自动下载 DSH + 插件）
curl -fsSL https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.sh | bash
```

或手动下载脚本后执行：

```bash
# 从本地 tgz 安装
./scripts/install.sh --plugin ./dsh-terminal-manager-0.0.1.tgz

# DSH 已装好，只装插件
./scripts/install.sh --skip-dsh
```

---

## 🔧 手动安装

### 第一步：下载插件

从 GitCode 下载最新版本的 tgz 包：

```bash
# 方式一：直接下载 tgz
wget https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.0.1/dsh-terminal-manager-0.0.1.tgz

# 方式二：git clone 后本地打包
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build
pnpm pack
```

### 第二步：安装到 DSH Profile

使用 DSH 内置的插件管理命令：

```bash
# 安装插件（会自动注册到 bundles）
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-terminal-manager-0.0.1.tgz
```

这个命令会：
1. 初始化 profile（如果不存在）
2. 运行 `pnpm add` 安装插件
3. 自动将插件添加到 `dsh.profile.bundles`

### 第三步：启动 DSH

```bash
npx @deepseek-ai/dsh web
```

启动后，你应该能在左侧边栏看到「终端」入口。

---

## ✅ 验证安装

1. **启动 DSH**：
   ```bash
   npx @deepseek-ai/dsh web --port 3000
   ```

2. **打开浏览器**：访问 `http://localhost:3000`

3. **检查插件加载**：
   - 左侧边栏应出现「🖥️ 终端」按钮
   - 点击后右侧应展开终端工作区

4. **检查客户端资源**：
   ```bash
   curl -I http://localhost:3000/plugins/dsh-terminal-manager/client.js
   # 应返回 HTTP 200
   ```

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

## 🐛 常见问题

### Q: 启动后看不到终端按钮？

**A:** 检查以下几点：
1. Profile 的 `package.json` 是否正确配置了 `dsh.profile.bundles`
2. 浏览器控制台是否有报错（F12 打开开发者工具）
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

### Q: 浏览器显示空白或加载失败？

**A:**
1. 清除浏览器缓存
2. 检查 `~/.dsh/profiles/<profile>/node_modules/dsh-terminal-manager` 是否存在
3. 重新运行 `pnpm install` 在 profile 目录

---

## 📁 目录结构说明

```
~/.dsh/                          # DSH 用户数据根目录
├── profiles/                    # Profile 目录
│   └── web/                     # web profile
│       ├── package.json         # Profile 配置（bundles 在这里）
│       ├── cordis.yml           # Cordis 配置（通常为空）
│       ├── cordis.patch.yml     # 补丁配置
│       └── node_modules/        # 安装的插件
│           └── dsh-terminal-manager/
└── sessions/                    # 会话数据
```

---

## 🔄 更新插件

### 方式一：覆盖安装

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-terminal-manager
npx @deepseek-ai/dsh plugin --profile web add /path/to/new/dsh-terminal-manager-0.0.2.tgz
```

### 方式二：从 Git 更新

```bash
cd /path/to/dsh-terminal-manager
git pull
pnpm build
pnpm pack
# 然后重新安装 tgz
```

---

## 🗑️ 卸载插件

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-terminal-manager
```

然后重启 DSH。

---

## 📞 获取帮助

- **问题反馈**：[GitCode Issues](https://gitcode.com/pengpengR/dsh-terminal-manager/issues)
- **讨论区**：[GitCode Discussions](https://gitcode.com/pengpengR/dsh-terminal-manager/discussions)

---

## 📄 许可证

MIT License
