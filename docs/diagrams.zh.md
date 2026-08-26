# 架构图解（看图版）

- 每张图配一句话说明；想读文字版看 `docs/architecture.zh.md`
- 日期：2026-08-26

---

## 图 1：整个系统里都有谁

> 三个角色：你和 AI 都在 DSH 里，设备在外面，插件是中间那座桥。

```mermaid
flowchart LR
    你["👤 你"]
    AI["🤖 DSH AI"]
    插件["🔌 终端管理插件"]
    设备群["🖧 远程设备<br/>web-01 / db-02 / …"]

    你 -- "看界面、敲命令" --> 插件
    AI -- "调工具发命令" --> 插件
    插件 -- "SSH / Telnet" --> 设备群
    你 <-. "对话" .-> AI
```

## 图 2：代码跑在哪两个地方

> 同一个插件分两半：一半在你电脑的 DSH 进程里干活，一半在浏览器里画界面。

```mermaid
flowchart TB
    subgraph 你的电脑
        subgraph 浏览器["🌐 浏览器"]
            界面["插件浏览器半<br/>（你看到的界面）"]
        end
        subgraph DSH进程["⚙️ DSH host 进程（Node.js）"]
            host半["插件 host 半<br/>（真正干活的部分）"]
            AI引擎["AI 引擎"]
        end
    end
    设备["🖧 远程设备"]

    界面 <-. "① HTTP：控制指令<br/>（连接/保存配置）" .-> host半
    界面 <-. "② WebSocket：字符流<br/>（你敲的字 / 设备的输出）" .-> host半
    host半 <-- "③ SSH / Telnet" --> 设备
    AI引擎 --- host半
```

## 图 3：插件内部模块地图

> 六块积木，从上往下调用：AI 工具和界面都通过中间的「会话管理器」操作设备。

```mermaid
flowchart TB
    subgraph 入口层["入口层（三个门）"]
        门1["🚪 AI 工具 ×6"]
        门2["🚪 控制面 RPC"]
        门3["🚪 数据面 WebSocket"]
    end
    门1 -- "AI 走这" --> SM
    门2 -- "界面点按钮走这" --> SM
    门3 -- "打字/看输出走这" --> SM
    SM["🧠 会话管理器<br/>（所有活跃会话的大脑）"]
    SM --> CS["🗄️ 连接存储（设备清单）"]
    SM --> TR["🔧 传输层"]
    TR --> SSH["SSH 实现"]
    TR --> TEL["Telnet 实现"]
```

## 图 4：一次「人点连接」的流程

> 从你点按钮到终端出现，经过的站点。

```mermaid
sequenceDiagram
    participant 你
    participant 界面 as 浏览器界面
    participant host as host 半
    participant 设备

    你->>界面: 在「连接」页点【连接】
    界面->>host: HTTP：请连接 web-01
    host->>host: 查连接存储拿地址/凭据
    host->>设备: 建立 SSH 连接（认证）
    设备-->>host: ✅ 连接成功
    host-->>界面: 会话已就绪
    界面->>host: 打开 WebSocket 字符管道
    设备-->>host: 欢迎横幅…
    host-->>界面: 实时推字符
    界面-->>你: 终端窗格出现 ✅
```

## 图 5：一次「AI 发命令」的流程

> AI 走工具门，多了一步「等命令跑完」的判定。

```mermaid
sequenceDiagram
    participant AI
    participant 工具 as AI 工具层
    participant SM as 会话管理器
    participant 设备

    AI->>工具: tm_send(会话, "show version")
    工具->>SM: 发送并等待完成
    SM->>设备: 写入命令
    设备-->>SM: 输出流（持续到达）
    Note over SM: 完成判定：<br/>输出停顿 0.5 秒？<br/>出现提示符？<br/>超时 30 秒？
    SM-->>工具: ✅ 判定完成，整段输出
    工具-->>AI: 返回结果
    AI-->>AI: 汇总告诉你
```

## 图 6：输出只有一份，同时送往两处

> 这是「人和 AI 共用终端」的核心：设备输出进缓冲后兵分两路。

```mermaid
flowchart LR
    设备 --> SM["会话管理器"]
    SM --> 缓冲["🗃️ 环形缓冲<br/>（最近 1MB，随时回看）"]
    SM --> 路1["📺 推给浏览器屏幕"]
    SM --> 路2["⏳ 喂给完成判定器"]
    路2 --> AI["🤖 AI 拿到整段结果"]
    缓冲 -. "断线重开面板时<br/>从这里恢复画面" .-> 路1
```

## 图 7：一个会话的一生

> 状态机：只能按箭头走，断线不会凭空消失。

```mermaid
stateDiagram-v2
    [*] --> 未连接: 配置已保存
    未连接 --> 连接中: 人点连接 / AI 调 tm_connect
    连接中 --> 已连接: 认证成功
    连接中 --> 未连接: 失败（密码错/不通）
    已连接 --> 已连接: 收发命令、广播、隐藏/显示窗格
    已连接 --> 未连接: 点 ✕ 断开 / 设备掉线
```

## 图 8：四条通信管道，各干各的

> 谁走哪条路，一眼分清。

```mermaid
flowchart LR
    subgraph 浏览器
        UI[界面]
    end
    subgraph host进程
        H[host 半]
    end
    subgraph 设备侧
        D1[SSH 设备]
        D2[Telnet 设备]
    end
    UI -- "HTTP（一问一答）<br/>保存配置/连接/断开" --> H
    UI <-- "WebSocket（双向流水）<br/>敲键下行 / 输出上行" --> H
    H <-- "SSH（加密）" --> D1
    H <-- "裸 TCP" --> D2
```

## 图 9：代码目录 ↔ 模块对照

> 以后看代码时按图索骥。

```mermaid
flowchart LR
    subgraph 仓库 terminal-manager/
        F1["src/connection-store.ts"]
        F2["src/transport/ssh.ts"]
        F3["src/transport/telnet.ts"]
        F4["src/session-manager.ts"]
        F5["src/wait-policy.ts"]
        F6["src/tools.ts"]
        F7["src/remotes.ts"]
        F8["src/ws-io.ts"]
        F9["client/*.tsx"]
    end
    F1 --- M1["连接存储"]
    F2 & F3 --- M2["传输层"]
    F4 --- M3["会话管理器"]
    F5 --- M4["完成判定"]
    F6 --- M5["AI 工具 ×6"]
    F7 --- M6["控制面 RPC"]
    F8 --- M7["数据面 WS"]
    F9 --- M8["浏览器界面"]
```

## 图 10：构建打包一条线

> 你写的 TS → 两个产物 → 分别装进两个环境。

```mermaid
flowchart LR
    TS["📝 TypeScript 源码<br/>src/ + client/"]
    TS -- "pnpm build<br/>（tsdown 编译+打包）" --> P1["lib/index.js<br/>host 半"]
    TS -- "同上" --> P2["lib/client.js<br/>浏览器半"]
    P1 -- "DSH host 进程加载" --> 宿主["⚙️ 干活"]
    P2 -- "浏览器启动时注入页面" --> 页面["🌐 显示"]
```

---

**还有哪里晕，指给我看——可以继续补图。**
