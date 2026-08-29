# 发布指南 - DSH Terminal Manager

本文档说明如何将插件发布到 GitCode 并供他人使用。

---

## 📦 已完成的准备工作

✅ 代码已提交：`git commit aa31c57`
✅ 版本标签：`v0.0.1`
✅ 打包文件：`dsh-terminal-manager-0.0.1.tgz`（170KB）

---

## 🚀 发布步骤

### 第一步：在 GitCode 创建仓库

1. 访问 [https://gitcode.com](https://gitcode.com) 并登录
2. 点击右上角 **「新建仓库」**
3. 填写信息：
   - **仓库名称**：`dsh-terminal-manager`
   - **描述**：`DSH 终端管理插件：SSH/Telnet 多会话终端、AI 工具集成`
   - **可见性**：选择「公开」或「私有」
   - **不要勾选**「初始化仓库」（README/LICENSE 等）
4. 点击 **「创建」**

> **注意**：仓库已创建在 https://gitcode.com/pengpengR/dsh-terminal-manager

### 第二步：配置远程仓库并推送

```bash
cd D:/myProject/dsh/terminal-manager

# 添加 GitCode 远程仓库
git remote add origin https://gitcode.com/pengpengR/dsh-terminal-manager.git

# 推送代码
git push -u origin main

# 推送标签
git push origin v0.0.1
```

### 第三步：创建 Release 并上传 tgz

1. 在 GitCode 仓库页面，点击 **「发布」→「新建发布」**
2. 或访问：`https://gitcode.com/pengpengR/dsh-terminal-manager/releases/new`
3. 填写信息：
   - **标签**：选择 `v0.0.1`
   - **标题**：`v0.0.1 - 首个发布版本`
   - **描述**：
     ```markdown
     ## 功能特性
     
     - SSH/Telnet 多会话终端管理
     - AI 工具集成 (`tm_connect`/`tm_send`/`tm_read` 等)
     - 命令守卫安全拦截
     - 广播命令到多台设备
     - 收藏/重连/多窗口布局
     - 完整安装文档和一键脚本
     
     ## 安装方式
     
     ### 一键脚本安装
     ```bash
     # Windows PowerShell
     irm https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.ps1 | iex
     
     # Linux/macOS
     curl -fsSL https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.sh | bash
     ```
     
     ### 手动安装
     下载下方 `dsh-terminal-manager-0.0.1.tgz`，参考 [安装文档](./INSTALL.zh.md)
     ```
   - **附件**：上传 `dsh-terminal-manager-0.0.1.tgz`
4. 点击 **「发布」**

---

## 🔗 安装链接（发布后更新）

发布后，更新以下文件中的链接（将 `<用户名>` 替换为你的 GitCode 用户名）：

### README.zh.md
```markdown
# Windows 一键安装
irm https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.ps1 | iex

# Linux/macOS 一键安装
curl -fsSL https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.sh | bash
```

### INSTALL.zh.md
更新所有 `https://gitcode.com/pengpengR/...` 为实际 URL。

---

## 📝 快速命令汇总

```bash
# 1. 进入项目目录
cd D:/myProject/dsh/terminal-manager

# 2. 添加远程仓库
git remote add origin https://gitcode.com/pengpengR/dsh-terminal-manager.git

# 3. 推送代码和标签
git push -u origin main
git push origin v0.0.1

# 4. 重新打包（如果需要）
pnpm pack
# 产出: dsh-terminal-manager-0.0.1.tgz
```

---

## 🎯 用户安装方式

发布后，用户可以通过以下方式安装：

### 方式一：一键脚本
```bash
# 下载脚本后运行
./scripts/install.ps1 -PluginPath ./dsh-terminal-manager-0.0.1.tgz
```

### 方式二：手动下载 tgz
1. 从 Release 页面下载 `dsh-terminal-manager-0.0.1.tgz`
2. 运行：
   ```bash
   cd ~/.dsh/profiles/web
   pnpm add /path/to/dsh-terminal-manager-0.0.1.tgz
   ```

### 方式三：从源码安装
```bash
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build
pnpm pack
# 然后安装 tgz
```

---

## 📊 发布检查清单

- [ ] GitCode 仓库已创建
- [ ] 代码已推送到 main 分支
- [ ] v0.0.1 标签已推送
- [ ] Release 已创建
- [ ] tgz 文件已上传到 Release
- [ ] README.zh.md 和 INSTALL.zh.md 中的链接已更新
- [ ] 测试一键安装脚本是否正常工作

---

## 🔄 后续版本发布流程

```bash
# 1. 更新版本号
# 编辑 package.json 的 version 字段

# 2. 重新构建和打包
pnpm build
pnpm pack

# 3. 提交更改
git add .
git commit -m "chore: bump version to 0.0.2"

# 4. 创建新标签
git tag -a v0.0.2 -m "v0.0.2: 更新说明"

# 5. 推送
git push origin main
git push origin v0.0.2

# 6. 在 GitCode 创建新 Release，上传新 tgz
```

---

## 💡 提示

- **GitCode 支持 Webhook**：可以配置 CI/CD 自动构建
- **GitCode 支持 Issues**：用于收集用户反馈
- **考虑发布到 npm**：如果想让更多人方便安装，可以 `npm publish`
