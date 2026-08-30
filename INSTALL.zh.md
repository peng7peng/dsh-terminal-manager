# DSH Terminal Manager 安装指南

> 🖥️ SSH/Telnet 多会话终端管理器 —— DSH 插件
>
> **仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager

---

## 📋 前提条件

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | ≥ 22 | [下载](https://nodejs.org/) |
| pnpm | ≥ 11 | `npm install -g pnpm` |
| Git | 任意版本 | 用于克隆仓库 |

检查版本：
```bash
node --version    # 应显示 v22.x 或更高
pnpm --version    # 应显示 11.x 或更高
```

---

## 🚀 安装方式

### 方式一：一键脚本（推荐）

先 clone 仓库，然后运行安装脚本。脚本自动完成所有步骤：

```bash
# 1. 克隆仓库
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager

# 2. 运行安装脚本
#    Windows PowerShell:
.\scripts\install.ps1

#    Linux / macOS:
./scripts/install.sh
```

脚本会自动完成：
1. 检查 Node.js 和 pnpm
2. 安装依赖 (`pnpm install`)
3. 构建插件 (`pnpm build`)
4. 注册到 DSH `web` profile

可选参数：
```bash
./scripts/install.sh --profile my-profile    # 指定 profile
./scripts/install.sh --dir /opt/dsh-plugins  # 指定安装目录
.\scripts\install.ps1 -Profile my-profile     # Windows
```

### 方式二：手动安装

如果你想完全控制安装过程：

```bash
# 1. 克隆仓库
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager

# 2. 安装依赖并构建
pnpm install
pnpm build

# 3. 安装到 DSH profile
#    Linux / macOS:
npx @deepseek-ai/dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"
#    Windows PowerShell:
npx @deepseek-ai/dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"
```

> **为什么用 `@link:` 语法？** 这告诉 pnpm 用符号链接指向你的本地目录，这样你更新代码后 DSH 会自动使用最新版本。

### 方式三：npm 安装（待发布后可用）

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-terminal-manager
```

> 这是最简单的方式——一行命令，无需 clone。发布到 npm 后即可使用。

### 方式四：tgz 手动安装

从 [GitCode Releases](https://gitcode.com/pengpengR/dsh-terminal-manager/releases) 下载 `.tgz` 文件：

```bash
npx @deepseek-ai/dsh plugin --profile web add ./dsh-terminal-manager-0.1.0.tgz
```

---

## ▶️ 启动

```bash
npx @deepseek-ai/dsh web
```

浏览器自动打开 http://127.0.0.1:3080

左侧边栏底部出现「🖥️ 终端」按钮，点击即可使用。

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

4. **尝试连接**：
   - 点击「连接」面板的 + 号
   - 填写 SSH/Telnet 连接信息
   - 点击「连接」

---

## 🔄 更新插件

```bash
cd <插件安装目录>   # 默认 ~/.dsh/plugins/dsh-terminal-manager
git pull
pnpm install
pnpm build
# 然后重启 DSH
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

### Q: 安装脚本报错 "pnpm not found"？

**A:** 安装 pnpm：
```bash
npm install -g pnpm
```

---

## 📞 获取帮助

- **问题反馈**：[GitCode Issues](https://gitcode.com/pengpengR/dsh-terminal-manager/issues)
- **讨论区**：[GitCode Discussions](https://gitcode.com/pengpengR/dsh-terminal-manager/discussions)

---

## 📄 许可证

[MIT](LICENSE)
