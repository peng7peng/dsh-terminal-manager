import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        // 当前基线（src-only）；#3 补单测后上调
        statements: 72,
        functions: 72,
        branches: 60,
        lines: 74,
      },
    },
  },
})
