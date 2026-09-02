import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
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
