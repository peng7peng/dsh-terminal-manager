import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    server: {
      deps: {
        // npm 安装的 @deepseek-ai/dsh-client-* 包位于 node_modules 内，默认会被 vitest
        // 外部化、交给 Node ESM 加载；而这些包的 lib/*.js 会 import .module.css，
        // Node 不认 .css 扩展名 → 整套测试文件加载失败：
        //   TypeError: Unknown file extension ".css" for .../dsh-client-ui-primitives/lib/StateDot.module.css
        // 内联进 vite 流水线即可（此前依赖软链到 DSH 源码、目录在 node_modules 之外，
        // 本来就是内联处理的，所以只有 npm 安装方式才暴露这个问题）。
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // 2026-09-08 用户确认：纯类型声明文件（无运行时逻辑）排除出覆盖率统计
      exclude: ['src/types/**', 'src/ext/port-log/types.ts'],
      thresholds: {
        // 2026-09-02 用户要求 90%：语句 / 函数 / 行 ≥ 90；分支 80（实际 85，剩余是传输层错误分支与防御性判断）
        statements: 90,
        functions: 90,
        branches: 80,
        lines: 90,
      },
    },
  },
})
