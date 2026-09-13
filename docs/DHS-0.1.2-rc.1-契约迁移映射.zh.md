# DSH 0.1.2-rc.1 契约迁移映射（dsh-terminal-manager）

> 调研对象：`dsh-terminal-manager` 从 DSH `0.1.2-alpha.3` 升到 `0.1.2-rc.1` 后，其引用的「已被上游删除/改名」的包应换成什么。
> 调研方式：**只读静态分析**（`read` / `grep` / `glob`），未修改 DSH checkout 与插件源码，未运行构建或测试。
> 上游版本证据：`D:\myProject\dsh\deepseek-harness\package.json:3` → `"version": "0.1.2-rc.1"`。
> 树结构证据：`packages/host/` 下只有 `directory-picker*`、`frontend-static`、`plugin-inventory`、`webserver`；`packages/client/` 下只有 `connection`、`hmr`、`locale`、`modules`、`store`、`ui-*`、`web`。**`packages/host/apiproxy` 与 `packages/client/runtime` 均已不存在。**
> 全仓库 grep `"@deepseek-ai/dsh-client-runtime"` 与 `dsh-host-apiproxy` → **零匹配**，即这两个包在 rc.1 树里没有任何残留引用（连迁移说明都没有）。

---

## ① 结论速查表

| # | 现状（文件:行号） | 应改成 | 依据（文件:行号） | 确定性 |
|---|---|---|---|---|
| 1 | `src/remotes.ts:12` `import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'` | `import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'`（若想保留 `RpcResult` 这个名字，再写一行本地别名 `type RpcResult<T> = ConnectionRpcResult<T>`） | 类型定义：`packages/client/connection/src/rpc.ts:25-27`；失败结构：同文件 `:18-22`；包根导出名：`packages/client/connection/src/index.ts:24`；包名：`packages/client/connection/package.json:2`；**host 侧先例**：`packages/api/gateway/src/index.ts:10` | **有确凿证据** |
| 2 | `ctx.webServer.register` / `registerUpgrade`（`src/remotes.ts:466,473-479`、`src/ws-io.ts:122,155`） | **写法仍然有效，不需要改**；来源包是 `@deepseek-ai/dsh-host-webserver`（`WebRoute` / `WebUpgradeRoute`） | `packages/host/webserver/src/index.ts:22-25`（Context 合并）、`:42-48`（`WebRoute`）、`:51-56`（`WebUpgradeRoute`）、`:165-172`（`register`）、`:180-186`（`registerUpgrade`）；包名 `packages/host/webserver/package.json:2`；旧注释提到的参考文件仍存在且写法未变：`packages/client/connection/src/index.ts:7,114-116,127` | **有确凿证据** |
| 3 | `client/index.tsx:6` 注释 + `src/remotes.ts:6` 注释写 `prefix: '/term-manager'` | 注释改成 `path: '/term-manager'`（**实际代码 `src/remotes.ts:473-474` 已经是 `path`，只有注释是错的**） | `packages/host/webserver/src/index.ts:42-48`（字段名是 `path`，没有 `prefix` 字段） | **有确凿证据** |
| 4 | `client/index.tsx:10`、`client/ext/index.tsx:9`、`client/ext/port-log/index.tsx:1`、`tests/ext-port-log-index.spec.ts:5` → `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'` | `import type { Context as ClientContext } from '@deepseek-ai/cordis'` | 该写法是 rc.1 唯一写法：`packages/client/ui-sidebar/src/client/index.ts:2` + `:39`；全仓库 147 处 `ClientContext` 命中，**无一处**从 `dsh-client-runtime` 来；`packages/` 下没有任何包导出名为 `ClientContext` 的类型（grep `export (type\|interface) ClientContext` → 无匹配） | **有确凿证据** |
| 5 | 同上四处（浏览器半要 `ctx.slots`） | **额外补** `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'` | `ctx.slots` 来自 declaration merge：`packages/client/ui-renderer/src/client/index.ts:42-47`；ui-sidebar 的同样做法：`ui-sidebar/src/client/index.ts:5-6` | **有确凿证据** |
| 6 | `@deepseek-ai/dsh-client-store` 是不是 `ClientContext` 的继任者？ | **不是。** 它是 §4 里「平台模块 seed」`dsh-client-runtime/client` 的继任者，与 context 类型无关。它导出 store 引擎与 store 契约类型，子路径只有 `.`/`./src/*`/`./package.json`，**没有 `/client`** | 导出清单：`packages/client/store/src/index.ts:20-24,27,46,67,103,183,217`；exports map：`packages/client/store/package.json:16-23`；seed 位置：`packages/client/web/src/platform.ts:10` | **有确凿证据** |
| 7 | `package.json:27-30` `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-sidebar"]` | 删 `@deepseek-ai/dsh-client-runtime`；`@deepseek-ai/dsh-client-ui-sidebar` **建议保留**（见 §3.3） | 合法值判定：`scripts/verify-client-packages.ts:330-340`、`:476`、`:482-495`（只校验「非空字符串、不重复」）；消费点：`packages/client/modules/src/client/system.ts:165-168`；语义：`packages/client/modules/src/client/manifest.ts:45-48,57-58` | 删 runtime：**确凿**；保留 sidebar：**语义建议，非上游强制** |
| 8 | `tsdown.config.ts:35` `'@deepseek-ai/dsh-client-runtime/client'` | **删掉这一行。** 若迁移后浏览器半真的 value-import 了 `@deepseek-ai/dsh-client-store`，在该位置加 `'@deepseek-ai/dsh-client-store'`（根 specifier，无 `/client`） | `packages/client/web/src/platform.ts:8-13`（`PLATFORM_MODULES` 精确内容）；`packages/client/web/src/seed.ts:33`（seed key 用根 specifier）；`packages/client/web/README.md:42` | **删 runtime：确凿**；加 store：**条件性建议** |
| 9 | 浏览器半 7 处 value-import `@deepseek-ai/dsh-client-ui-primitives` | **不用改**：仍是平台模块，specifier 形式正确（包根，无 `/client`） | `packages/client/web/src/platform.ts:12`；`packages/client/web/src/seed.ts:16,35`；`packages/client/ui-primitives/package.json:16-23`；图标仍存在：`ui-primitives/src/icons/index.tsx:422,569,674` | **有确凿证据** |

---

## ② 逐条详细依据

### §1 host 半的「RPC 返回值」类型

**(a) 候选排除**

* `packages/api/remotes` = `@deepseek-ai/dsh-api-remotes`（`packages/api/remotes/package.json:2`）。它的 `./types` 子路径（`package.json:25-28`）指向 `src/types.ts`，该文件只导出 `ApiRemoteForwardedEvent`（`src/types.ts:15`），和 RPC 结果无关；根 face 只导出：

```ts
// packages/api/remotes/src/index.ts:30-31
export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'
```

→ **`packages/api/remotes` 不是 RPC 结果类型的来源。**

* `packages/api/gateway` = `@deepseek-ai/dsh-api-gateway`（`package.json:2`）。根 face 的完整类型导出清单里**没有任何 `Rpc*Result`**：

```ts
// packages/api/gateway/src/index.ts:60-72
export type {
  InvokeRemoteRequest, TypertGateway, TypertGatewayErrorCode, TypertGatewayWireStream,
  TypertRemoteEventContext, TypertRemoteEventDispatch, TypertRemoteEventFrame,
  TypertRemoteEventInvocation, TypertRemoteEventOutcome, TypertRemoteEventSource,
} from './types.ts'
export type { RemoteEventHostInfo } from './stream-protocol.ts'
```

全仓库 grep `RpcResult` 在 `packages/api` 只 9 处，无一处是类型定义/导出定义（`gateway/src/index.ts:113-114,356,590,998,1014` 全是 `Awaited<ReturnType<ConnectionRpcHandler>>` 的本地别名或内部函数签名）。

→ **`packages/api/gateway` 不是 RPC 结果类型的来源。**

**(b) 正解：`packages/client/connection`**

类型定义处：

```ts
// packages/client/connection/src/rpc.ts:17-30
/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Historical short name for a generic Connection result. */
export type RpcResult<T> = ConnectionRpcResult<T>
```

这与插件现有用法**逐字段等价**：

```ts
// dsh-terminal-manager/src/remotes.ts:53-62
function toError(error: unknown): RpcResult<never>['error'] {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'INTERNAL'
  return { code: 'internal', message: `${code}: ${message}`, details: {} }
}
function ok<T>(value: T): RpcResult<T> { return { ok: true, value } }
```

导出路径的关键区别（**这是本条的坑**）：

* 包根 `@deepseek-ai/dsh-client-connection`：`packages/client/connection/src/index.ts:14-33` 的导出清单里有 `ConnectionRpcResult`（`:24`），**没有** `RpcResult`。
* client face `@deepseek-ai/dsh-client-connection/client`：`src/client/index.ts:31-36` 同时导出 `RpcResult` 和 `ConnectionRpcResult`。
* `@deepseek-ai/dsh-api-remotes/client`：`packages/api/remotes/src/client/index.ts:56-61` 再导出 `RpcResult` —— 但那是 **client face**：

```
// packages/api/remotes/src/client/index.ts:51-61
/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@deepseek-ai/dsh-client-connection/client'
```

**host 侧的实证先例**（`packages/api/gateway` 是 host 包，它就是这么写的）：

```ts
// packages/api/gateway/src/index.ts:10
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
```

→ 结论：**host 半插件写 `import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'`**。包名里带 `client-` 是历史命名（该包自述为 “Host HTTP bridge for browser-client RPC”，`packages/client/connection/src/index.ts:1`），不影响 host 使用。

**(c) `ctx.webServer.register` / `registerUpgrade` 仍然有效**

`WebServer` 服务把 `register` / `registerUpgrade` 作为公开方法，`WebRoute` / `WebUpgradeRoute` 是显式导出的类型：

```ts
// packages/host/webserver/src/index.ts:38-56
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}
```

```ts
// packages/host/webserver/src/index.ts:165-172
register(route: WebRoute): () => void {
  const table = route.kind === 'exact' ? this.exact : this.prefixes
  ...
}
// packages/host/webserver/src/index.ts:180-186
registerUpgrade(route: WebUpgradeRoute): () => void { ... }
```

Context 合并在同一文件 `:22-25`（`webServer: WebServer`）。旧注释提到的参考文件 **仍然存在且写法未变**：

```ts
// packages/client/connection/src/index.ts:7
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
// packages/client/connection/src/index.ts:114-127
const route: WebRoute = { kind: 'prefix', path: API_PATH, handler: async (req, res) => { ... } }
ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
```

插件现状核对：

* `src/remotes.ts:473-479` → `{ kind: 'prefix' as const, path: '/term-manager', handler }` + `ctx.effect(() => webServer.register(route), ...)` ✅ 与 rc.1 一致。
* `src/ws-io.ts:155` → `webServer.registerUpgrade({ path: '/term-io', handler })` ✅ 与 rc.1 一致。
* `src/ext/port-log/index.ts:51-54` → `{ kind: 'prefix' as const, path: PORT_LOG_ROUTE_PREFIX }` ✅。
* **只有注释错**：`src/remotes.ts:6` 写 `ctx.webServer.register({ kind: 'prefix', prefix: '/term-manager' })` —— rc.1 的 `WebRoute` **没有 `prefix` 字段**，字段名是 `path`。

**补充观察（非本次任务要求，但影响迁移安全性）**：插件 host 半**没有**把 `@deepseek-ai/dsh-host-webserver` 列入任何依赖节，也不用 `ctx.webServer`，而是 `ctx.get('webServer')`（`src/remotes.ts:466`、`src/ws-io.ts:122`、`src/ext/port-log/index.ts:51`）。这意味着 `WebRoute` 的类型约束当前并不真正参与类型检查。若要恢复类型安全，需在 devDependencies 加 `@deepseek-ai/dsh-host-webserver` 并加 `import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'`。

### §2 浏览器半的 context 类型

**(a) 正解：`@deepseek-ai/cordis` 的 `Context`，本地别名为 `ClientContext`**

```ts
// packages/client/ui-sidebar/src/client/index.ts:1-39（节选）
/** Registers the sidebar shell into the layout-owned slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
...
/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'locale']

export function apply(ctx: ClientContext): void { ... }
```

同一写法在 DSH 自己的 client 包里是**唯一**写法。grep `ClientContext` 在 `deepseek-harness` 命中 147 处，来源全部是 `@deepseek-ai/cordis`，覆盖 `ui-sidebar`、`ui-layout`、`ui-theme`、`ui-settings*`、`ui-conversation`、`locale`、`ui-approval`、`ui-subagent`、`ui-input-trigger`、`experimental/client-ui-agent-team`、`session-query/session-log-export` 等约 40 个包。**没有任何一处**来自 `dsh-client-runtime`。

同时，`packages/` 下**不存在**导出 `ClientContext` 类型的包（grep `export (type|interface) ClientContext` → 无匹配）。所以「从哪个包的哪个子路径 import `ClientContext`」这个问题的答案是：**没有这个包，它只是一个本地别名习惯**。

**(b) `ctx.slots` 的来源必须单独 import**

`ctx.slots` 不是 context 类型自带的，而是 ui-renderer 打进来的 Cordis Context 合并：

```ts
// packages/client/ui-renderer/src/client/index.ts:33-48
declare module '@deepseek-ai/cordis' {
  interface Events {
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}
```

所以插件需要 `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'`，与 ui-sidebar 的做法一致（`ui-sidebar/src/client/index.ts:5-6`）。

插件现有的 `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'`（`client/index.tsx:11`）**不足以**带来 `ctx.slots`。它带来的是 SlotMap 的声明（`ui-sidebar/src/client/contract/slots.ts:16-47`，含 `'sidebar.footer.action'` 于 `:46`），而 ui-sidebar 的 contract 会**传递地**把 ui-layout 的 SlotMap 合并拉进来，这正是插件能用 `'shell.overlay'` 的原因：

```ts
// packages/client/ui-sidebar/src/client/contract/slots.ts:12-14
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
```

```ts
// packages/client/ui-layout/src/client/index.ts:37,86
interface SlotMap {
  ...
  'shell.overlay': { kind: 'list'; scope: 'root' }
```

→ 结论：`'shell.overlay'` 由 **ui-layout** 声明，`'sidebar.footer.action'` 由 **ui-sidebar** 声明；插件靠 ui-sidebar 的传递 type import 才看到前者。这条链路是隐式的，迁移时建议显式补上 `import type {} from '@deepseek-ai/dsh-client-ui-layout/client'`（可选，但更稳）。

**(c) `@deepseek-ai/dsh-client-store` 到底导出什么**

它是**快照 store 引擎**，不是 context：

```ts
// packages/client/store/src/index.ts（导出点）
export function notifySubscribers<Args ...>(...)          // :46
export function shallowEqual(a: unknown, b: unknown)      // :67
export function createSnapshotStore<T>(init, opts?)       // :103
export interface SnapshotStore<T> extends ObservableSnapshot<T>  // :27
export interface EngineStoreInstance<T, A> extends StoreInstance<T, A>  // :177
export interface EngineStoreHandle<T, A> extends StoreHandle<T, A>      // :183
export function defineStore<T, A extends ActionsDecl<T>>(decl)          // :217
export type { ActionsDecl, BakedActions, BoundActions, DefineStore, HandleOf, ...,
  ObservableSnapshot, PropsStore, SnapshotSelectorHook, StoreDecl, StoreFactory,
  StoreHandle, StoreInstance, StoreSpec } from './contract.ts'          // :20-24
```

子路径：

```jsonc
// packages/client/store/package.json:16-23
"exports": {
  ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./src/*":  "./src/*",
  "./package.json": "./package.json"
}
```

**没有 `./client` 子路径。** 浏览器半要用它，specifier 是包根 `@deepseek-ai/dsh-client-store`（这也正是 `PLATFORM_MODULES` 里的 seed key，见 §4）。

### §3 `dsh.client.inject` 的合法取值

**§3.1 判定：没有白名单枚举。合法值 = 「非空、不重复的字符串数组」，值本身是包名。**

校验点一（DSH 自己的门禁，格式层）：

```ts
// scripts/verify-client-packages.ts:330-340
for (const pkg of facts.declarations.filter(entry => entry.dynamic)) {
  for (const field of ['external', 'inject'] as const) {
    const seen = new Set<string>()
    for (const value of pkg[field]) {
      if (value === '') violations.push(pkg.manifest + ': dsh.client.' + field + ' contains an empty value')
      else if (seen.has(value)) {
        violations.push(pkg.manifest + ': dsh.client.' + field + ' lists ' + JSON.stringify(value) + ' twice')
      }
      seen.add(value)
    }
  }
  ...
```

```ts
// scripts/verify-client-packages.ts:476（读声明）+ :482-495（类型校验）
inject: stringArray(rawClient.inject, manifest.name, manifestPath, 'inject', malformed),
...
if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
  malformed.push(manifestPath + ': ' + packageName + ' dsh.client.' + field + ' must be a string array')
  return []
}
```

注意 `collectModuleViolations` 的 **supplier 检查（`:342-380`）只作用于 `external`，对 `inject` 没有任何「必须有对应 row / 必须存在」的检查**。

校验点二（宿主读取时的形状校验，`packages/client/modules/src/index.ts:210`）：

```ts
const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
```

**§3.2 消费点：查不到就静默跳过**

```ts
// packages/client/modules/src/client/system.ts:143-170（节选）
/** Register each injected package and unresolved dynamic request before its consumer. */
private async arriveGraphRow(row: BootModuleRow, open, visited): Promise<void> {
  ...
  for (const packageName of row.inject) {
    const dependency = this.graphRows.get(packageName)
    if (dependency !== undefined) await this.arriveGraphRow(dependency, [], visited)
  }
  await this.arrive(row)
}
```

**`graphRows.get()` 返回 `undefined` 时什么都不做** —— 一个已消亡的包名（如 `@deepseek-ai/dsh-client-runtime`）**不会报错，也不会报缺失**。这正是它「静默失效」的原因，也是必须主动删的理由（留着的坏处是误导读者 + 文档漂移，不是崩溃）。

**§3.3 语义：informational only**

```ts
// packages/client/modules/src/client/manifest.ts:42-63（节选）
/**
 * One composed client entry pushed by the host (a graph row).
 * `immediately` marks stage-one prefetch. `inject` names package rows whose
 * factories must arrive before this row materializes, while Cordis separately
 * uses the same package edges to compose entries. `external` carries exact
 * non-inject module requests.
 */
export interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  ...
  /** Package-name dependency edges used for factory arrival and plugin composition. */
  inject?: string[]
```

`packages/client/AGENTS.md`（Web client stack 规则，新包清单第 3 条）原文：

> **dsh.client manifest semantics**: `platform: 'web'` always, and the declaration requires a `./client` export (the scan throws without one); `immediately: true` only for stage-one-prefetch infrastructure rows. **`inject` lists package-name dependency edges — they are informational only (preflight display, HMR diffing); they do not sequence entry activation or apply order.** Activation order is Cordis fiber inject waiting on *services*, nothing else.

同一文件「The module graph sits below cordis DI」一节也把 `dsh.client.inject` 与 Cordis service `inject`、module-graph `external` 并列为「三类声明互不替代」，并称其为「the informational package-name edges」。

**§3.4 插件两行的判定**

| 值 | 包在 rc.1 是否存在 | 是否有动态 `dsh.client` row | 判定 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | **否**（全仓库 grep 零匹配） | — | **必须删** |
| `@deepseek-ai/dsh-client-ui-sidebar` | 是（`packages/client/ui-sidebar/package.json:2`） | 是（同文件 `:28-40`，`inject` + `platform: 'web'`） | **建议保留**（合法；删除也不报错） |

保留 `@deepseek-ai/dsh-client-ui-sidebar` 的语义理由：插件**确实**注册进该包声明的槽位（`ui-sidebar/src/client/contract/slots.ts:46` 声明 `'sidebar.footer.action'`），并且它已经在该包的 devDependencies 里（插件 `package.json:90`）。它同时也满足 DSH 内部的一条**惯例**（注意：这是 DSH 自己 workspace 的门禁，不覆盖插件）：

```ts
// scripts/verify-package-dependencies.ts:486-488
for (const name of facts.clientInject) {
  if (facts.workspaceNames.has(name)) add(name, 'devDependencies', 'dsh.client.inject')
}
```

**§3.5 参考插件 `DSH-better-sidebar/package.json` 的 inject 清单依据**

```jsonc
// DSH-better-sidebar/package.json:46-54
"client": {
  "inject": [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-modules"
  ],
  "platform": "web"
}
```

逐条核对（rc.1 树）：

| 值 | rc.1 里有此包？ | 有 `dsh.client` 动态 row？ | 依据 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-locale` | 是 | 是（`inject`+`platform: 'web'`+`immediately: true`） | `packages/client/locale/package.json:2,28-39` |
| `@deepseek-ai/dsh-client-ui-conversation` | 是（包目录存在） | —（本次未逐读其 package.json） | `packages/client/ui-conversation/` 目录存在 |
| `@deepseek-ai/dsh-client-modules` | 是 | 是（`platform: 'web'`, `inject: []`, `immediately: true`） | `packages/client/modules/package.json:3,32-38` |
| `@deepseek-ai/dsh-client-ui-slots` | 是 | **否** —— 该 `package.json` 全文**没有 `dsh` 键**，所以没有动态 row | `packages/client/ui-slots/package.json`（全文 37 行，无 `dsh` 字段） |

**这一条最有价值**：`@deepseek-ai/dsh-client-ui-slots` 是一个**基线平台模块**（`PLATFORM_MODULES` 成员，`packages/client/web/src/platform.ts:11`），它没有动态 row；但 better-sidebar 把它写进 `inject`，而 `verify-client-packages` 也没有报错。这**直接证明** `dsh.client.inject` 的值不受「必须是动态 row」约束，也不存在枚举白名单 —— 它是一份作者手写的、描述「我依赖哪些 client 包」的信息性清单。

同时 better-sidebar 的 `AGENTS.md` §3 第 7 条记录了同一件事的实践结论：

> **`@deepseek-ai/dsh-client-runtime` 包已消亡**（继任 seed 是裸名 `dsh-client-store`，无 `/client` 子路径）：peerDependencies、devDependencies、`dsh.client.inject`、chunk externals 白名单（`src/client/chunk-loader.ts` / `tsdown.config.ts` / `tests/chunk-loader.spec.ts` / `tests/manifest-consistency.spec.ts` 四处同步）均已无该条目。

它对应的 externals 白名单实测如下（**注意它没有 `@deepseek-ai/dsh-client-store` 这一行，因为它不 value-import 它**）：

```ts
// DSH-better-sidebar/tsdown.config.ts:58-67
/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list; `dsh-client-runtime` was removed upstream in DSH 0.1.2-alpha and no chunk requires it). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
```

### §4 平台模块表（`packages/client/web/src/platform.ts` 精确内容）

该文件**全文 20 行**，内容如下（逐字）：

```ts
/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
```

* `PLATFORM_MODULES`（`:8-13`）实际 8 个 specifier：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`。
* `PRELOADED_CLIENT_EXTERNALS`（`:16-17`）是**空数组**。

消费方（seed 静态表，`satisfies` 投影约束保证两边不漂移）：

```ts
// packages/client/web/src/seed.ts:13-16,23-36（节选）
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
...
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
  return {
    'react': React, 'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom, 'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
  } satisfies Record<PlatformModule, unknown>
```

`packages/client/web/README.md:42` 对它的定位：

> `PLATFORM_MODULES` (in `src/platform.ts`) names the shell-seeded shared modules — React, Cordis, and static UI libraries — and together with `PRELOADED_CLIENT_EXTERNALS` (the parser-preloaded runtime row) defines the implicit external baseline every dynamic bundle resolves against. `dsh.client.external` adds only exact non-baseline requests.

**据此对插件 `tsdown.config.ts:27-36` 的逐行判定：**

| 行 | 值 | 在 `PLATFORM_MODULES` 内？ | 处置 |
|---|---|---|---|
| 28 | `'react'` | ✅ (`:9`) | 保留 |
| 29 | `'react/jsx-runtime'` | ✅ (`:9`) | 保留 |
| 30 | `'react-dom'` | ✅ (`:9`) | 保留 |
| 31 | `'react-dom/client'` | ✅ (`:9`) | 保留 |
| 32 | `'@deepseek-ai/cordis'` | ✅ (`:9`) | 保留 |
| 33 | `'@deepseek-ai/dsh-client-ui-slots'` | ✅ (`:11`) | 保留 |
| 34 | `'@deepseek-ai/dsh-client-ui-primitives'` | ✅ (`:12`) | 保留（**真被 value-import**，见 §5） |
| 35 | `'@deepseek-ai/dsh-client-runtime/client'` | ❌ **不在表内，且该包不存在** | **删除** |
| — | `'@deepseek-ai/dsh-client-store'` | ✅ (`:10`) | **仅当浏览器半真的 value-import 它时新增**（当前 grep 不到） |

补充观察（未经逐文件核查，标注为观察）：插件 host/client 源码里除 `react/jsx-runtime`（JSX 自动运行时）与 `@deepseek-ai/dsh-client-ui-primitives`（7 处图标）外，grep 不到其他 `@deepseek-ai/*` 的 **value** import（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-sidebar/client` 都是 `import type`，会被构建期擦除）。因此该列表里若干条目当前是「预留」，不影响正确性，但也不提供保护。

### §5 `@deepseek-ai/dsh-client-ui-primitives` 确认

* **仍是平台模块**：`packages/client/web/src/platform.ts:12` 是 `'@deepseek-ai/dsh-client-ui-primitives'`（正是这一行）。
* **seed table 里有它**：`packages/client/web/src/seed.ts:16`（静态 import）+ `:35`（表项 `'@deepseek-ai/dsh-client-ui-primitives': UiPrimitives`）。
* **specifier 形式正确（包根，无子路径）**：

```jsonc
// packages/client/ui-primitives/package.json:16-23
"exports": {
  ".":              { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./src/*":        "./src/*",
  "./package.json": "./package.json"
}
```

包名 `@deepseek-ai/dsh-client-ui-primitives`（同文件 `:2`），**没有 `/client` 子路径**。插件的 `import { IconXxx } from '@deepseek-ai/dsh-client-ui-primitives'` 形式正确。

* **插件的 value import 点（7 处）**：`client/ConnectionsPanel.tsx:8`、`client/editor/EditorWindow.tsx:8`、`client/editor/EditorTabs.tsx:7`、`client/files/RemoteFilePanel.tsx:11`、`client/files/FilePanel.tsx:9`、`client/tc/TcDialogs.tsx:7`、`client/tc/TcSummaryBar.tsx:6`、`client/tc/useTcActions.tsx:11`（共 8 处引用点，7 个文件）。
* **图标在 rc.1 仍存在**：`packages/client/ui-primitives/src/icons/index.tsx:422`（`IconLinkOutline14`）、`:569`（`IconPlayOutline16`）、`:674`（`IconFolderOpen16`）。本次抽查了这三个。
* **不需要 `dsh.client.external`**：按 `packages/client/AGENTS.md`「Shared modules and the module graph」第 1 条「Baseline externals are implicit for every dynamic bundle. Do not repeat React, Cordis, `client/store`, `ui-primitives`, or `ui-slots` in package manifests.」——基线模块隐式可用，插件 `package.json` 里也没有 `dsh.client.external`（正确）。

### §6 面向第三方插件开发者的契约文档

**结论：DSH checkout 里没有专门面向第三方插件开发者的「浏览器半契约」文档。** 现存的相关材料全部是**贡献者向**（in-repo）的 `AGENTS.md` + cookbook + 子系统页。逐份列出：

**(1) `docs/cookbook/adding-a-settings-card.zh.md` —— 最接近第三方浏览器半指南，且直接给出正确写法**

> 原文位于 `docs/cookbook/adding-a-settings-card.zh.md:52-70`（代码块标记为 ` ```ts ignore-check `，节选）：
>
> ```ts
> import type { Context as ClientContext } from '@deepseek-ai/cordis'
> // Type-only: the keyed slot's declaration. Cross-plugin collaboration goes
> // through cordis services; a value import fails the client bundle-purity gate.
> import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
>
> export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']
>
> export function apply(ctx: ClientContext): void {
>   const card = new MyPluginCardController(ctx.settingsScope.bind({ namespace: 'my-plugin' }))
>   ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ ... }, MyPluginCard))
> }
> ```

同一文档 `:82` 说明浏览器半如何被页面发现：

> 浏览器半侧由[客户端模块系统](../../packages/client/modules)提供给页面：它扫描已启用的 Loader entries 中声明了 `dsh.client` 的包，并提供每个包构建出的 `./client` 导出。因此只要 `cordis.yml` 挂载了该插件，它就会出现在页面上——无需重新构建 Web 应用。

同一文档 `:90` 是**全仓库唯一一处** `dsh.client.inject` 的示例：

```jsonc
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"] } }
```

**(2) `docs/cookbook/extension-cookbook.zh.md` —— 只覆盖 host 半插件，不含浏览器半**

其示例代码全部是 `import type { Context } from '@deepseek-ai/cordis'`（`:18`、`:42`、`:73`）+ `export const inject = [...]`（`:51`、`:76`），没有 `dsh.client` / slots / PLATFORM_MODULES 内容。

**(3) `packages/client/AGENTS.md` —— 权威性最高的 client 侧规则（贡献者向）**

关键段落（原文摘录，均在 `packages/client/AGENTS.md`）：

* 「Slot and props discipline」第 1 条：*"**One API**: a plugin composes UI only through `ctx.slots.register({ name, children?, store?, inject? }, Component)`. There is no separate slot-definition call, no whitelist face object, no face-minting helper. The shell alone renders `'root'`."*
* 「Export discipline (client plugin packages)」第 3 条：*"A feature plugin MUST NOT runtime-import or re-export another feature plugin's values, and MUST NOT declare `dsh.client.external` to obtain them. Shared declarations use `import type`; behavior crosses packages through injected Cordis services, and UI crosses packages through slots."*
* 「ctx discipline (components never see ctx)」：*"`ctx` belongs to the apply world only: the plugin body and the inject factories closed over it."*
* 「New plugin package checklist」第 3 条：`inject` 是 informational only（全文见 §3.3）。
* 「Shared modules and the module graph」第 1 条：基线 externals 隐式可用，不要在 manifest 里重复 React / Cordis / `client/store` / `ui-primitives` / `ui-slots`。

**(4) `docs/subsystems/client-modules.zh.md` —— `dsh.client` 语义**

`:17`/`:20`/`:30` 内嵌 `WebBootEntry` 的类型注释；`:77`：

> 包加入这张表的方式，是在自己的 package.json 中声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边、可选的 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle。

**(5) `packages/client/web/README.md:42`** —— `PLATFORM_MODULES` 的角色（见 §4）。

**(6) `docs/subsystems/slots.md` / `docs/subsystems/web-client.md`** —— 槽位与 render 机制参考（`packages/client/AGENTS.md` 开篇要求先读这两份）。

**(7) 没有找到的东西（明确记录）**：
* `docs/cookbook/` 下**没有**名为「client plugin」「browser half」「第三方向」一类的条目；目录内容为 `adding-a-package` / `adding-a-remote-api` / `adding-a-settings-card` / `adding-a-tool` / `adding-a-vendored-package` / `adding-an-llm-adapter` / `extension-cookbook` / `maintaining-dsh-code-review` / `responding-to-pr-review-on-a-stack`。
* **未找到**任何文档说明「已消亡包的迁移映射表」或「`dsh-client-runtime` → 什么」的上游官方说明。唯一提到该迁移的是**参考插件自己**的 `DSH-better-sidebar/AGENTS.md` §3 第 7 条（第三方仓库，非上游权威），以及 `DSH-better-sidebar/tsdown.config.ts:58` 的注释。

---

## ③ 不确定项与需要人工确认的点

1. **host 侧插件该引用哪个包表达 RPC 返回值，存在两个结构上等价、但官方定位不同的选择。**
   * 方案 A（我的推荐）：`@deepseek-ai/dsh-client-connection` 根 face → `ConnectionRpcResult`。依据是 host 包 `packages/api/gateway/src/index.ts:10` 的实证先例。
   * 方案 B：`@deepseek-ai/dsh-api-remotes/client` → `RpcResult`（`packages/api/remotes/src/client/index.ts:59` 再导出）。但那是 **client face**，其注释（`:51-55`）明说「re-exported so a **business package** names one assembly package… the carrier's Client-facing types」。
   * **未找到证据**表明上游对「host 侧第三方插件」有明确规定，也**未找到**禁止使用方案 B 的证据。请人工裁决。

2. **插件 `src/remotes.ts` 的 `RpcResult` 并不是 Typert Remote 协议的一部分，而是插件自有 HTTP JSON 信封的约定。**
   证据：`src/remotes.ts:6` 的模块注释、`:473-479` 是一个 `webServer` prefix 路由、`spec.md:103` 明确写「**明确不用 `ctx.typert.remotes`**」。所以「换成 `ConnectionRpcResult`」是**结构等价复用**（`src/remotes.ts:54-58` 的 `{ code, message, details }` 与 `rpc.ts:18-22` 逐字段一致），**不是**「接入 Connection RPC」。
   是否要进一步改成真正的 `ctx.connection`（`HostConnectionHandle.rpc.handle`，`packages/client/connection/src/rpc.ts:132-157`）或 Typert Remote（`docs/cookbook/adding-a-remote-api.zh.md`）属于**设计决策**，本次未找到上游强制要求。**不猜。**

3. **`dsh.client.inject` 是否该保留 `@deepseek-ai/dsh-client-ui-sidebar`：上游没有强制。**
   证据表明：删除它不会报错（`system.ts:165-168` 静默跳过；`verify-client-packages.ts:330-340` 只查格式），保留它也不会报错。我建议保留（语义上插件确实依赖该包声明的槽位），但**这是建议，不是确凿的强制结论**。请人工确认取舍。

4. **`DSH-better-sidebar/tsdown.config.ts:64` 写的是 `'cordis'`，而 `platform.ts:9` 的 seed key 是 `'@deepseek-ai/cordis'` —— 两者不一致。**
   我未读该插件全部 client 源码，**无法判定**这是笔误，还是它的 client 代码真的 `import 'cordis'`。**不要把 better-sidebar 的 externals 清单当作 `@deepseek-ai/cordis` 拼写的依据**——拼写应以 `packages/client/web/src/platform.ts:9` 为准（插件 `tsdown.config.ts:32` 写的 `'@deepseek-ai/cordis'` 是对的）。这一条已标注为**未确认**。

5. **`PRELOADED_CLIENT_EXTERNALS` 在 rc.1 是空数组，我未找到任何「非空」的 rc.1 例子**，无法给出该字段的实测用例。因此无法判断插件将来是否需要它（当前显然不需要）。

6. **插件 host 半对 `@deepseek-ai/dsh-host-webserver` 没有类型依赖。** 它用 `ctx.get('webServer')`（`src/remotes.ts:466`、`src/ws-io.ts:122`、`src/ext/port-log/index.ts:51`）而非 `ctx.webServer`，且 `package.json` 里没有该包。因此 `WebRoute` / `WebUpgradeRoute` 的类型约束当前**不真正生效**。这是「上游写法是否需要同步」之外的一个独立隐患，但**是否要修**属于设计取舍，本次不定论。

7. **未做动态验证。** 按硬约束「只调研，不改代码」，我没有运行 `pnpm build` / `pnpm test` / `tsc`，也没有启动 DSH 实例。所有结论均为**静态阅读 + grep** 的结果。特别是：迁移后能否通过类型检查，未实测。

8. **§4 的「可先不加 `@deepseek-ai/dsh-client-store`」是条件性判断。** 若本次迁移只修契约、不引入 `defineStore`，则当前无处 value-import 它，加不加都不影响构建；一旦浏览器半引入 `defineStore`，**必须**同时加进 `CLIENT_BASELINE_EXTERNALS` 并加 devDependency，否则该模块会被内联成私有副本（丢失模块表身份）。这一「丢失身份」的后果属**机制推论**（基于 `packages/client/AGENTS.md`「Silence means a private copy」与 `dsh-client-store` 是 seed key 这两条证据），本次未实测。

---

## ④ 建议的改动清单（只列文件与改动要点，不含实际修改）

> 全部改动都限定在 `D:\myProject\dsh\dsh-terminal-manager`。**不要**修改 `D:\myProject\dsh\deepseek-harness`。

### 必改（阻断迁移：引用了不存在的包）

1. **`src/remotes.ts:12`**
   `import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'`
   → `import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'`，并在同处或 `:53` 上方加本地别名 `type RpcResult<T> = ConnectionRpcResult<T>`（这样 `:54`、`:60`、`:72` 三处使用点**无需改动**）。

2. **`client/index.tsx:10`**
   `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'`
   → `import type { Context as ClientContext } from '@deepseek-ai/cordis'`

3. **`client/ext/index.tsx:9`**、**`client/ext/port-log/index.tsx:1`**、**`tests/ext-port-log-index.spec.ts:5`**
   同上改法（注意 `tests/ext-port-log-index.spec.ts:5` 之后 `:6` 已有一行 `import type { Context } from '@deepseek-ai/cordis'`，合并或保持两行均可，但不要产生重复标识符冲突）。

4. **`package.json:27-30`**
   从 `dsh.client.inject` 删除 `"@deepseek-ai/dsh-client-runtime"`；保留 `"@deepseek-ai/dsh-client-ui-sidebar"`。

5. **`tsdown.config.ts:35`**
   删除 `'@deepseek-ai/dsh-client-runtime/client'`。若迁移后引入 `@deepseek-ai/dsh-client-store` 的 value import，在该位置加 `'@deepseek-ai/dsh-client-store'`（**根 specifier，不能带 `/client`**）。

### 建议改（正确性/可维护性，非阻断）

6. **`client/index.tsx:11` 附近**
   新增 `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'` —— 这是 `ctx.slots` 类型的来源（ui-sidebar 的做法见 `packages/client/ui-sidebar/src/client/index.ts:5-6`）。建议同时显式补 `import type {} from '@deepseek-ai/dsh-client-ui-layout/client'`（`'shell.overlay'` 的声明方，见 `ui-layout/src/client/index.ts:86`），避免继续依赖 ui-sidebar 的传递 type import。

7. **`src/remotes.ts:6`（注释）**
   `ctx.webServer.register({ kind: 'prefix', prefix: '/term-manager' })`
   → `ctx.webServer.register({ kind: 'prefix', path: '/term-manager', handler })`（rc.1 的 `WebRoute` 字段是 `path`；实际代码 `:473-474` 已正确，只有注释错）。

8. **`package.json:86-106` devDependencies / `:34-47` peerDependencies**
   * `@deepseek-ai/dsh-client-ui-sidebar` 已在 `:90` / `:38`，无需变。
   * 若采用第 1 条，新增 `@deepseek-ai/dsh-client-connection`（devDependency 即可，因为只是 `import type`）。
   * 若采用第 6 条，新增 `@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-layout`。
   * 若引入 `defineStore`，新增 `@deepseek-ai/dsh-client-store`。
   * 可选：新增 `@deepseek-ai/dsh-host-webserver` 并显式 `import type { WebRoute, WebUpgradeRoute }`，让路由类型真正参与检查（对应 §③ 第 6 条）。

### 确认后可能改（依赖第 ③ 节的人工裁决）

9. 若裁决要把指令通道改为真正的 Connection RPC 或 Typert Remote，则 `src/remotes.ts:460-479` 的挂载方式、`spec.md:103`、`plan.md:17`、`CLAUDE.md` 第 4 条都要一并重写。**本次不建议**：`spec.md:103` 已记录绕开 `connection.rpc.handle` 与 `/api` 的理由。

### 明确不要改

10. **`client/**/*.tsx` 里对 `@deepseek-ai/dsh-client-ui-primitives` 的 8 处 value import** —— 该 specifier 在 rc.1 仍是合规平台模块（§5），不要改成任何其他形式、也不要加子路径。
11. **`src/remotes.ts:473-479`、`src/ws-io.ts:122-155`、`src/ext/port-log/index.ts:51-54`** —— `ctx.webServer.register` / `registerUpgrade` 的调用形态与 rc.1 完全一致，不要动。
12. **`package.json` 的 `dsh.bundle.patch` / `cordis.patch.yml`** —— 与本次契约迁移无关。

---

## 附：本次调研的证据文件索引（便于复核）

| 主题 | 关键文件 |
|---|---|
| 上游版本 / 树结构 | `deepseek-harness/package.json:3`、`packages/host/`、`packages/client/` 目录列举 |
| RPC 结果类型 | `packages/client/connection/src/rpc.ts:17-30`、`src/index.ts:14-33`、`src/client/index.ts:31-36`、`packages/api/gateway/src/index.ts:10,60-72`、`packages/api/remotes/package.json:2,16-31`、`src/types.ts:15`、`src/client/index.ts:51-61` |
| WebServer 路由 | `packages/host/webserver/package.json:2`、`src/index.ts:22-25,38-56,165-172,180-186`、`packages/client/connection/src/index.ts:1,7,114-127` |
| Browser context 类型 | `packages/client/ui-sidebar/src/client/index.ts:2,5-6,39`、`packages/client/ui-renderer/src/client/index.ts:33-48`、`packages/client/ui-layout/src/client/index.ts:37,86`、`packages/client/ui-sidebar/src/client/contract/slots.ts:12-14,46`、`packages/client/ui-renderer/src/client/registry.ts:27-45,172,606-613` |
| client-store 导出 | `packages/client/store/package.json:2,16-23`、`src/index.ts:20-24,27,46,67,103,177,183,217` |
| dsh.client.inject | `packages/client/modules/src/index.ts:200-221`、`src/client/manifest.ts:42-63`、`src/client/system.ts:143-170`、`scripts/verify-client-packages.ts:330-340,442-495`、`scripts/verify-package-dependencies.ts:486-488`、`packages/client/AGENTS.md` |
| 平台模块表 | `packages/client/web/src/platform.ts:1-20`（全文）、`src/seed.ts:13-36`、`packages/client/web/README.md:42` |
| ui-primitives | `packages/client/ui-primitives/package.json:2,16-23`、`src/icons/index.tsx:422,569,674` |
| 第三方文档 | `docs/cookbook/adding-a-settings-card.zh.md:48-94`、`docs/cookbook/adding-a-remote-api.zh.md:1-70`、`docs/cookbook/extension-cookbook.zh.md:18,42,51,73,76`、`docs/subsystems/client-modules.zh.md:5,17,20,30,77`、`packages/client/AGENTS.md` |
| 参考插件（第三方，非上游权威） | `DSH-better-sidebar/package.json:42-55,141-173`、`tsdown.config.ts:58-67`、`AGENTS.md` §3 第 7 条 |
