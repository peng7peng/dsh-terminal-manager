# 重构后 UI 修复视觉证据（Before / After）

同一场景、视口（1440×900）、浅色主题，实际 DSH Web 应用截图。

- **Before**：main `ce14cc7`（PR #1–#4 合并后）。
- **After**：本 PR（`agent/verify-refactor-ui-8d2f875293a7`）。

## 1. 终端默认列数（`*-terminal-columns.png`）

1 台 Telnet 会话（127.0.0.1:2323）。

- Before：列数固定「2 列」，单会话窗格约 231px（约 25–28 列），长输出中途折行。
- After：列数默认「自动」，1 台会话自动 1 列，窗格约 467px；2 台以上自动 2 列；仍可手动选 1/2/3 列。

## 2. 文件列表图标（`*-file-icons.png`）

SSH 会话 + 远端文件面板（3 个文件）。

- Before：emoji 文件图标在无 emoji 字体环境显示为方块。
- After：`client/icons.tsx` 的线性 SVG 文件/文件夹/链接/外部打开图标。

## 3. 密码显隐图标（`*-password-eye.png`）

SSH 连接表单。

- Before：眼睛 emoji 显示为两个方块。
- After：线性眼睛 / 闭眼 SVG；点击仍可切换显隐。

## 4. 键盘模式弹层（`*-keyboard-menu.png`）

打开终端工具栏齿轮弹层后点击聊天区。

- Before：弹层仍然开着，只有再点齿轮才关。
- After：点击弹层外部自动关闭；Esc 也可关；点齿轮仍是开/关切换。

## 5. 其他同类图标（`*-pin.png`、`*-minimized.png`）

置顶图钉、编辑器最小化标签、Tab 加载/只读标记、「收藏」标题里的 emoji 一并换成 SVG 或纯文案。补充截图的 Before 取自 client 代码与 main 一致的旧构建。

## 6. 活跃会话行图标（后续反馈）

用户反馈文件列表修好后，活跃会话行里仍有「叉叉框框」。

| 场景 | Before（本 PR 首个提交 5e374ad） | After（本次提交） |
| --- | --- | --- |
| 显示中的会话（拖动/排序手柄） | `before-active-session.png`：`⣿` 显示为方块叉 | `after-active-session.png`：六点 SVG 手柄 |
| 已隐藏的会话（隐藏标记） | `before-active-session-hidden.png`：`⊘` 字符 | `after-active-session-hidden.png`：闭眼 SVG |
