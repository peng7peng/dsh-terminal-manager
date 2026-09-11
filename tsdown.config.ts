import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 把第三方 CSS 文本内联成虚拟模块 `tm:xterm-css`（对齐 DSH `?inline` 的产物形态，但避开 query 解析歧义）。 */
const inlineCssPlugin = {
  name: 'tm-inline-css',
  resolveId(source: string) {
    if (source === 'tm:xterm-css') return '\0tm-xterm-css'
    return null
  },
  load(id: string) {
    if (id !== '\0tm-xterm-css') return null
    const path = require.resolve('@xterm/xterm/css/xterm.css')
    const content = readFileSync(path, 'utf8')
    return `export default ${JSON.stringify(content)};`
  },
}

/**
 * 客户端 bundle 的模块表基线（与 deepseek-harness packages/client/web/src/platform.ts
 * 的 PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS 保持一致）：
 * 这些说明符在运行时由宿主模块表提供，打包时保持 external（require 调用）。
 */
const CLIENT_BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  // host 半：Node ESM，生产依赖保持 external（运行时由 DSH 安装解析）
  {
    name: 'dsh-terminal-manager/host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: true,
    external: [/^node:/, 'ssh2'],
    noExternal: [/^@deepseek-ai\/(schemastery|dsh-tools)$/],
  },
  // 浏览器半：惰性 CJS 工厂格式（window.__ModuleLoader__.load 包裹），
  // 复刻 deepseek-harness packages/client/tsdown.client.ts 的输出契约
  {
    name: 'dsh-terminal-manager/client',
    entry: { client: 'client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    clean: false,
    jsx: 'automatic',
    jsxImportSource: 'react',
    deps: {
      // 基线模块走 require（宿主模块表提供），其余（xterm、ssh2 等）一律打包内联
      neverBundle: (specifier: string) => CLIENT_BASELINE_EXTERNALS.includes(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_BASELINE_EXTERNALS.includes(specifier),
    },
    plugins: [inlineCssPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-terminal-manager", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
