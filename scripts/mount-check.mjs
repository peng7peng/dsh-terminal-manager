/**
 * npm 通道真机挂载验证（合入 main / 发布前跑一次）。
 *
 * 验证的是**用户实际走的那条路**，而不是源码 link：
 *   1. `pnpm pack` 出 tarball；
 *   2. 在隔离的 DSH_HOME（临时目录，绝不碰真实 ~/.dsh）里预置一个 web profile；
 *   3. 用官方 CLI `dsh plugin --profile web add file:<tarball>` 装进去；
 *   4. 启动真实 `dsh web`（--port 0 由系统分配，不占用 3080/3180）；
 *   5. 用就绪行里带一次性 token 的 URL 换 cookie（0.1.2+ 裸 URL 会 401），断言：
 *      - 首页 200 且 `__DSH_BOOT__` 里出现本插件的 client 行；
 *      - 首页给该行分配的产物 URL 返回 200 且体积正常；
 *   6. 收尾：杀掉服务、删掉 scratch 目录（KEEP_HOME=1 可保留排障）。
 *
 * 用法：
 *   node scripts/mount-check.mjs                 # 打包 + 隔离挂载 + 断言
 *   MOUNT_FROM_NPM=0.1.0-rc.1 node scripts/mount-check.mjs    # 从 npm registry 装
 *   MOUNT_FROM_NPM=next node scripts/mount-check.mjs          # 用 dist-tag 装
 *   KEEP_HOME=1 node scripts/mount-check.mjs     # 保留 scratch 目录
 *   DSH_CMD="pnpm dsh" node scripts/mount-check.mjs   # 指定 dsh 入口
 *   DSH_PORT=0 node scripts/mount-check.mjs      # 指定端口（0=系统分配）
 *
 * 退出码：0 = 全绿；1 = 有断言失败（原因打印在最后）。
 *
 * 两个环境事实（都在本脚本里处理好了，排障时容易踩）：
 *   - 全新 profile 由 `dsh plugin add` 初始化时**只带 dsh-base + 插件**，缺
 *     `@deepseek-ai/dsh-web-app` —— 插件等 webServer 会 pending、boot 直接失败。
 *     所以这里像 better-sidebar 的 e2e-mount.sh 一样手工预置 bundles。
 *   - 预置 `allowBuilds: {ssh2: false, cpu-features: false}`（纯 JS 回退），
 *     否则 pnpm 11 会报 ERR_PNPM_IGNORED_BUILDS 让安装失败。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP_HOME = process.env.KEEP_HOME === '1' || process.env.KEEP_HOME === 'true'
const PORT = process.env.DSH_PORT ?? '0'
const READY_TIMEOUT_MS = 120_000
const POLL_MS = 1_000

const say = (m) => console.log(`\x1b[36m[mount-check]\x1b[0m ${m}`)
const ok = (m) => console.log(`\x1b[32m  ✅ ${m}\x1b[0m`)
const bad = (m) => console.log(`\x1b[31m  ❌ ${m}\x1b[0m`)

/** 待收尾的现场：scratch 目录与 dsh 子进程（失败路径也必须清干净）。 */
let scratch = ''
let child = null

/** 统一的收尾：杀掉 dsh 子进程、删掉 scratch（KEEP_HOME=1 则保留），再按 code 退出。 */
function teardown(code) {
  if (child?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  if (scratch) {
    if (KEEP_HOME) console.log(`   （KEEP_HOME 已设置，保留 ${scratch}）`)
    else rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(code)
}

function fail(m) {
  bad(m)
  console.log('\n结论：挂载验证失败\n')
  teardown(1)
}

/** 拼一个能执行 `dsh <args...>` 的命令：DSH_CMD / PATH 上的 dsh / DSH 源码 checkout / npx。 */
function resolveDsh() {
  if (process.env.DSH_CMD) return { cmd: process.env.DSH_CMD, prefix: [], shell: true }

  const probe = spawnSync('dsh', ['--version'], { stdio: 'ignore', shell: true })
  if (probe.status === 0) return { cmd: 'dsh', prefix: [], shell: true }

  // DSH 源码 checkout：`pnpm dsh ...`（只认 package.json 里有 dsh 脚本的目录，
  // 不去试探性地执行命令——避免误判后退回 npx 触发联网下载）
  for (const candidate of [join(ROOT, '..', 'deepseek-harness'), join(ROOT, '..', '..', 'deepseek-harness')]) {
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {}
      if (scripts.dsh) return { cmd: 'pnpm', prefix: ['dsh'], shell: true, cwd: candidate }
    } catch { /* 读不动就当没有 */ }
  }

  const npx = spawnSync('npx', ['--version'], { stdio: 'ignore', shell: true })
  if (npx.status === 0) {
    return { cmd: 'npx', prefix: ['-y', '--package', '@deepseek-ai/dsh', 'dsh'], shell: true }
  }
  return null
}

// ---------- 1. 决定安装来源（本地 tarball / npm registry） ----------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const pluginName = pkg.name

/**
 * 安装来源：
 *   - 缺省：本地 `pnpm pack` 出的 tarball（改代码后验证，离线可用）
 *   - `MOUNT_FROM_NPM=<版本或 tag>`：从 npm registry 装（发版后验证真实用户路径，
 *     顺带验证 registry 解析 / dist-tag / 发布产物是否完整）
 */
const FROM_NPM = process.env.MOUNT_FROM_NPM ?? ''
let installTarget = ''

if (FROM_NPM) {
  say(`安装来源：npm registry —— ${pluginName}@${FROM_NPM}（跳过本地打包）`)
  installTarget = `${pluginName}@${FROM_NPM}`
} else {
  say('打包 tarball（prepack 会自动构建）...')
  const packed = spawnSync('pnpm', ['pack'], { cwd: ROOT, encoding: 'utf8', shell: true })
  if (packed.status !== 0) fail(`pnpm pack 失败：\n${packed.stdout ?? ''}${packed.stderr ?? ''}`)
  const tgzName = (packed.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.endsWith('.tgz')).pop()
  if (!tgzName) fail(`没解析到 tarball 文件名：\n${packed.stdout ?? ''}`)
  const tgz = join(ROOT, tgzName)
  ok(`tarball：${tgzName}`)
  installTarget = `file:${tgz.replace(/\\/g, '/')}`
}

// ---------- 2. 隔离 scratch（绝不写真实 ~/.dsh） ----------
scratch = mkdtempSync(join(tmpdir(), 'dsh-mount-check-'))
const dshHome = join(scratch, 'home')
const profileDir = join(dshHome, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
mkdirSync(join(scratch, 'workspace'), { recursive: true })

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2) + '\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

# ssh2 / cpu-features 走纯 JS 回退：显式 false = 不需要构建脚本，
# pnpm 11 不再报 ERR_PNPM_IGNORED_BUILDS。
allowBuilds:
  ssh2: false
  cpu-features: false

minimumReleaseAgeExclude:
  - ${pluginName}
  - '@deepseek-ai/*'
`)
say(`隔离 DSH_HOME：${dshHome}`)

if (FROM_NPM) {
  // 固定走官方源：本机全局 npmrc 常指向 npmmirror，而刚发布的版本在镜像上
  // 可能还没同步，会造成「包不存在」的假失败。
  writeFileSync(join(profileDir, '.npmrc'), 'registry=https://registry.npmjs.org\n')
  say('npm 模式：scratch profile 固定走 registry.npmjs.org（避免镜像同步延迟造成假失败）')
}

// ---------- 3. 官方 CLI 装 tarball ----------
const dsh = resolveDsh()
if (!dsh) fail('找不到 dsh 入口：设置 DSH_CMD，或确保 PATH 上有 dsh，或把 DSH 源码放在仓库同级目录')
say(`dsh 入口：${dsh.cmd} ${dsh.prefix.join(' ')}`.trim())

const env = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
const addArgs = [...dsh.prefix, 'plugin', '--profile', 'web', 'add', installTarget]
say(`执行：${dsh.cmd} ${addArgs.join(' ')}`)
const added = spawnSync(dsh.cmd, addArgs, { cwd: dsh.cwd ?? ROOT, env, encoding: 'utf8', shell: true })
if (added.status !== 0) fail(`挂载失败：\n${added.stdout ?? ''}${added.stderr ?? ''}`)

const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
if (!(profile.dsh?.profile?.bundles ?? []).includes(pluginName)) {
  fail(`已安装但 ${pluginName} 不在 dsh.profile.bundles 里：\n${JSON.stringify(profile, null, 2)}`)
}
ok(`挂载已注册：bundles = [${profile.dsh.profile.bundles.join(', ')}]`)

// ---------- 4. 启动真实 dsh web ----------
const bootArgs = [...dsh.prefix, '--profile', 'web', '--port', PORT, '--no-open']
say(`启动：${dsh.cmd} ${bootArgs.join(' ')}（port ${PORT}，0=系统分配）`)
child = spawn(dsh.cmd, bootArgs, { cwd: dsh.cwd ?? ROOT, env, shell: true })
let log = ''
child.stdout.on('data', (d) => { log += d.toString() })
child.stderr.on('data', (d) => { log += d.toString() })

let exitedEarly = false
child.on('exit', (code) => { if (code !== null && code !== 0) exitedEarly = true })

/** 等就绪行：`dsh web: http://127.0.0.1:<port>/?token=<43字符>`（0.1.2+ 带一次性 token）。 */
async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const m = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?\S*)/)
    if (m) return m[1]
    if (exitedEarly) return null
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return null
}

const url = await waitReady()
if (!url) {
  fail(`等不到 dsh web 就绪（${READY_TIMEOUT_MS / 1000}s）。日志尾部：\n${log.split(/\r?\n/).slice(-25).join('\n')}`)
}
say(`dsh web 就绪：${url.replace(/token=\S+/, 'token=***')}`)

// ---------- 5. token 换 cookie，断言首页与产物 ----------
let cookie = ''

/**
 * 手动跟跳转的 GET：就绪行给的 token URL 会先回 303 换取签名 cookie
 * （DSH 0.1.2+ 的鉴权方式），跟着 location 走完才是真正的页面。
 * 每跳都收一次 set-cookie，之后带着 cookie 请求插件产物。
 */
async function get(u, depth = 0) {
  const res = await fetch(u, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ')

  const location = res.headers.get('location')
  if (res.status >= 300 && res.status < 400 && location && depth < 5) {
    return get(new URL(location, u).toString(), depth + 1)
  }
  return res
}

try {
  const pageRes = await get(url)
  if (pageRes.status !== 200) fail(`首页 HTTP ${pageRes.status}（期望 200；裸 URL 401 属正常，这里用的是带 token 的 URL）`)
  const html = await pageRes.text()
  ok(`首页 HTTP 200（${html.length} 字符）`)

  // __DSH_BOOT__ 里的 client 行：{"id":"<包名>","url":"/plugins/??...","inject":[...]}
  const row = html.match(new RegExp(`\\{"id":"${pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}","url":"([^"]+)"`))
  if (!row) fail(`首页 __DSH_BOOT__ 里没有 ${pluginName} 的 client 行`)
  const assetUrl = row[1].replace(/&amp;/g, '&')
  ok(`BOOT 行存在：${assetUrl}`)

  const assetRes = await get(`http://127.0.0.1:${new URL(url).port}${assetUrl}`)
  const body = await assetRes.text()
  if (assetRes.status !== 200) fail(`插件产物 HTTP ${assetRes.status}（期望 200）：${assetUrl}`)
  if (!body.includes('__ModuleLoader__')) fail('插件产物里没有 __ModuleLoader__ 包装——不是 DSH client bundle')
  if (body.length < 100_000) fail(`插件产物只有 ${body.length} 字节，疑似不完整`)
  ok(`插件产物 HTTP 200（${body.length} 字节，含 __ModuleLoader__ 包装）`)

  // host 半是否真的激活（插件在挂载路由时会打印）
  if (log.includes('[term-manager]') || log.includes(pluginName)) ok('host 半激活（日志里有插件自己的输出）')
} catch (error) {
  fail(`断言过程抛错：${error instanceof Error ? error.message : String(error)}`)
}

console.log('\n\x1b[32m结论：npm 通道真机挂载验证全绿 ✅\x1b[0m\n')
teardown(0)
