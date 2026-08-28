# DSH 终端管理插件（dsh-terminal-manager）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装的终端管理插件：人与 AI **共用同一批远程终端**（SSH / Telnet），AI 能在对话里直接操作设备终端。

## 能力

- **SSH / Telnet** 连接（密码 + 密钥；Telnet 裸 TCP）；
- 多会话同屏终端（xterm.js），可拖动调聊天/终端宽度（大屏拖动上限随视口放大，终端可收很窄）；
- **AI 工具** `tm_connect` / `tm_list` / `tm_send` / `tm_send_all` / `tm_read` / `tm_disconnect`——AI 在对话里调，自主连设备、发命令、拿回结果；
- **命令守卫**：AI 发的危险命令（`rm -rf /` 等）自动拦截；
- 广播：一条命令发多台，逐台独立出结果；
- 纯本地运行，不依赖 MCP。

## 安装

```sh
dsh plugin add ./terminal-manager   # 本地目录
# 或
dsh plugin add ./terminal-manager-0.0.1.tgz   # tarball
```

需 DSH 已安装（`npx @deepseek-ai/dsh`）。装好后侧边栏底部出现「🖥️ 终端管理」按钮。

## 开发

```sh
git clone <本仓库>
cd terminal-manager
pnpm install          # 依赖用 link: 指向相邻 deepseek-harness 检出
pnpm build            # 产出 lib/index.js（host 半）+ lib/client.js（浏览器半）
pnpm test             # 161 项 vitest（模拟设备，不碰真设备）
```

运行验证（相邻 deepseek-harness 检出）：

```sh
cd ../deepseek-harness
pnpm dsh --profile tm-dev --port 3180 --no-open   # profile 在 ~/.dsh/profiles/tm-dev
# 浏览器开 http://127.0.0.1:3180
```

本地联调模拟设备（无需真设备）：

```sh
node scripts/mock-device.mjs 2323   # 起一台模拟路由器 CLI
node scripts/mock-device.mjs 2324   # 第二台（测多会话/广播）
```

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

MIT。
