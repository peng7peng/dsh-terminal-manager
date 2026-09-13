# 发布指南 - DSH Terminal Manager

把插件发布到 npm，让用户用一条命令装：

```bash
dsh plugin --profile web add dsh-terminal-manager@latest
```

本文分三部分：**一次性准备** → **每次发版** → **回滚与排障**。想直接开干，看下面的快速清单。

---

## ⚡ 快速清单（发版时照抄这一整段）

> 本次改动在分支 `fix/install-update` 上。顺序是：**先在本分支把验证跑全绿 → 再提交推送、开 PR 合进 main → 最后才发版**。

```bash
# 0) 先在本分支验证（全绿才继续；这几条都不需要额外账号）
pnpm install                       # 期望：干净通过
pnpm test                          # 期望：54 个文件 / 621 项全绿
node scripts/run-e2e.mjs           # 期望：24 通过 / 0 失败
node scripts/mount-check.mjs       # 期望：npm 通道真机挂载全绿
#                                    （隔离 DSH_HOME，装 tarball 进全新 profile + 起真实 dsh web
#                                     + 断言首页 BOOT 行与产物 200，绝不碰你的 ~/.dsh）

# 0.5) 提交并推送当前分支
cd D:\myProject\dsh\dsh-terminal-manager          # bash 用 /d/myProject/dsh/dsh-terminal-manager
git add -A
git commit -m "feat: 安装方式拆为 npm/源码双轨，修复 pnpm install，完成 DSH 0.1.2-rc.1 契约迁移"
git push -u origin fix/install-update
#   然后去 GitCode 开 PR → 合并到 main

# 1) 切回 main 并同步
git checkout main
git pull origin main

# 2) 登录官方源（只需一次；本机全局 npmrc 指向的是只读镜像源，不能用来发布）
npm login --registry=https://registry.npmjs.org
npm whoami  --registry=https://registry.npmjs.org

# 3) 在 main 上本地验证（必须全绿才继续）
pnpm install                  # 期望：干净通过
pnpm test                     # 期望：54 个文件 / 621 项全绿
node scripts/run-e2e.mjs      # 期望：24 通过 / 0 失败

# 4) 看要发出去的文件（应恰好 6 个：LICENSE / README.md / cordis.patch.yml
#    / lib/client.js / lib/index.js / package.json）
npm pack --dry-run --registry=https://registry.npmjs.org

# 5) 首次发布，版本号已经是 0.1.0，直接打标签
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0

# 6) 发布（必须显式指定官方源；prepack 会自动构建，别手动先 build）
npm publish --registry=https://registry.npmjs.org

# 7) 验证发布结果
npm view dsh-terminal-manager version dist-tags --registry=https://registry.npmjs.org
dsh plugin --profile verify-publish add dsh-terminal-manager@latest
dsh web --profile verify-publish --port 3180      # 打开 3180，确认左侧边栏出现「🖥️ 终端」
dsh plugin --profile verify-publish remove dsh-terminal-manager

# 8) 去 GitCode 补一个 Release（标签选 v0.1.0，不再需要上传 tgz）
```

> 以后每次发版：先把 `package.json` 的 `version` 改高（例如 `0.1.1`），再走 3～8 步。
> 预发布版（`0.2.0-rc.1`）第 6 步换成 `npm publish --registry=https://registry.npmjs.org --tag next`，**不要占 `latest`**。
> **账号开了 2FA 的话，第 6 步必须带一次性验证码**：`npm publish --registry=https://registry.npmjs.org --otp=<6 位动态码>`，否则报 `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required`（详见 §一 步骤 4）。

---

## 一、一次性准备

| 事项 | 状态 / 做法 |
|------|-------------|
| npm 包名 `dsh-terminal-manager` | ✅ 已确认**未被占用**（registry 返回 404），直接用无 scope 的包名 |
| npmjs.com 账号 | 需要账号并已登录。**开了 2FA 就必须按 §一 步骤 4 处理发布鉴权**（`--otp` 或带 bypass-2FA 的 granular token），否则发布会 403 |
| 发布源 | ⚠️ **必须发到官方源 `https://registry.npmjs.org`**。本机 `.npmrc` 配的是 `registry.npmmirror.com`（只读镜像），直接 `npm publish` 会失败 |
| 发版机器 | Node ≥ 22、pnpm ≥ 11、仓库干净（`git status` 无未提交改动） |

### 1. 确认登录状态

```bash
npm whoami --registry=https://registry.npmjs.org
# 未登录则：
npm login --registry=https://registry.npmjs.org
```

### 2. （可选）给本仓库单独指定官方源

在仓库根建 `.npmrc`（**别动全局配置**，否则日常装包会变慢）：

```ini
registry=https://registry.npmjs.org
```

### 3. GitCode CI 密钥（自动发版用）

在 GitCode 仓库的 **设置 → 密钥 / 环境变量** 里加一条：

- 名称：`NPM_TOKEN`
- 值：npmjs.com 生成的 **Granular Access Token**，且**必须勾上「绕过 2FA / Bypass 2FA」**（否则 CI 里发布会同样 403），权限 Read and write，作用域只限 `dsh-terminal-manager` 这一个包

> 配置入口与 CI 配置文件格式取决于仓库启用的 CI 形式（GitCode Actions / CNB `.cnb.yml`），**待确认后再补自动发版章节**——在那之前用手动流程发版，效果完全一样。

### 4. 2FA：发布时怎么过（实测踩过）

npmjs.com 账号一旦开了 2FA，**发布会被要求二次验证**。不带的话 `npm publish` 会在最后一步失败：

```
npm notice Publishing to https://registry.npmjs.org/ with tag next and public access
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/dsh-terminal-manager -
  Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

注意报错发生在**打包全部成功之后**（你会先看到 `total files: 6`、`shasum` 之类的正常输出），所以看到 6 个文件和 `Publishing to ...` 就说明包本身没问题，纯粹是鉴权。

两条路，任选：

**A. 每次发版带一次性动态码（最省事，适合手动发版）**

```bash
npm publish --registry=https://registry.npmjs.org --tag next --otp=123456
#                                                     ↑ 换成验证器 App 里的 6 位码
```

动态码是 30 秒一换的，**先跑命令再取码**最容易踩空；建议先在 App 里看好码、再立刻回车。

**B. 建一个「可绕过 2FA」的 granular token（推荐；CI 也用同一个）**

1. 打开 https://www.npmjs.com/settings/~/tokens → **Generate New Token** → **Granular Access Token**；
2. Name 随便；Expiration 按需（30/90 天）；
3. **Packages and scopes** 选 `dsh-terminal-manager` 这一个包（最小授权）；
4. **Permissions** 选 `Read and write`；
5. **勾上 Bypass 2FA（允许发布时绕过双因素）**——**这个选项默认是不勾的**，没勾就是最常见的 403 原因（令牌能 `whoami` 但发不了包）。勾选项在创建页面上，名叫 Bypass 2FA 之类；
6. 生成后**只显示一次**，立刻存好。写进用户级配置（**不要写进仓库的 `.npmrc`，会被提交**）：

```bash
npm config set //registry.npmjs.org/:_authToken=<粘贴令牌>
npm whoami --registry=https://registry.npmjs.org     # 能打印用户名 = 令牌生效
```

之后 `npm publish --registry=https://registry.npmjs.org` 就不需要 `--otp` 了。这条命令写的是**用户级** `~/.npmrc`，只对官方源生效，不影响你默认走 npmmirror 装包。

> **令牌能认证 ≠ 能发布**：`npm whoami` 成功只证明读权限可用；发布要写权限 + 2FA，所以「whoami 正常但 publish 403」几乎总是**令牌没勾 Bypass 2FA**。
>
> **两个官方安全变更（已核实，2026-09 现状）**：
> - 经典令牌（含 Automation token）**创建入口已关闭**，存量令牌 2025-11-19 起全部吊销 —— 只能用 granular token。
> - 带 Bypass 2FA 的 granular token **目前仍可直接发布**，但官方已公告：**目标 2027 年 1 月取消其直接发布能力**，届时须改用 [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) 或 staged publishing。也就是说：**CI 自动发版这条路，将来要迁到支持 OIDC 的 CI（如 GitHub Actions）**，GitCode CI 不在支持商名单里。手动发版（`--otp`）不受影响。
> - 另外：Bypass 2FA 令牌已不能做账号/包管理类敏感操作（建删令牌、改包权限与维护者、trusted publishing 配置），这些必须交互式 2FA。

> 想彻底免掉这一步，只能在账号设置里把 2FA 调成「仅授权时验证」——但 npm 现在默认并推荐「授权和写入都验证」，不建议为了发版降低账号安全等级。

---

## 二、每次发版（手动流程，逐步可验证）

### 步骤 1：改版本号

编辑 `package.json` 的 `version`，例如 `0.1.0` → `0.1.1`。

**版本号策略**（影响插件市场能否自动安装）：

- **稳定版**（`0.1.1` / `0.2.0`）→ 发到 `latest`。DSH Desktop 的 Community Market 自动安装要求「npm `latest` 返回精确稳定版本」，**只有稳定版才能进自动安装预览**。
- **预发布版**（`0.2.0-rc.1`）→ 用 `--tag next`（或 `--tag alpha`）发，**不要占 `latest`**；用户得显式 `dsh-terminal-manager@next` 才能装到。

### 步骤 2：本地验证（全绿才继续）

```bash
pnpm install                  # 干净安装
pnpm test                     # 54 个文件 / 621 项全绿
node scripts/run-e2e.mjs      # 24 个 E2E 场景全绿
node scripts/mount-check.mjs  # npm 通道真机挂载全绿（隔离 DSH_HOME，不碰 ~/.dsh）
```

`mount-check.mjs` 是**用户实际走的那条路**：`pnpm pack` → 全新 profile 里 `dsh plugin add file:<tarball>` → 起真实 `dsh web`（端口由系统分配）→ 用就绪行里带一次性 token 的 URL 换 cookie → 断言首页 `__DSH_BOOT__` 有本插件行、且该行给的产物 URL 返回 200。`pnpm test`/E2E 覆盖的是源码 link 通道，只有它覆盖 npm 安装通道。

> 手工验证时的两个坑（脚本已处理）：① 首页裸 URL 返回 **401** 属正常，必须用就绪行 `dsh web: http://127.0.0.1:<port>/?token=...` 先进一次（它会回 **303** 换签名 cookie）；② 产物地址在 DSH 0.1.2+ 是合并形式 `/plugins/??dsh-terminal-manager/client.js&rev=...`，旧的 `/plugins/dsh-terminal-manager/client.js` 会 404。

### 步骤 3：检查将要发布的内容

```bash
npm pack --dry-run --registry=https://registry.npmjs.org
```

应当只有 6 个文件：

```
LICENSE
README.md
cordis.patch.yml
lib/client.js
lib/index.js
package.json
```

`prepack` 钩子会在打包前自动跑 `pnpm build`，所以**不需要手动先构建**，也**不会把陈旧产物发出去**（`lib/` 是 gitignore 的，只有构建才有）。

> 清单里若出现 `src/`、`tests/`、`*.tgz`，检查 `package.json` 的 `files` 字段。

### 步骤 4：提交、打标签

```bash
git add -A
git commit -m "chore: bump version to 0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main
git push origin v0.1.1
```

### 步骤 5：发布

```bash
npm publish --registry=https://registry.npmjs.org

# 预发布版本：
npm publish --registry=https://registry.npmjs.org --tag next
```

### 步骤 6：验证发布结果

```bash
# ① 官方源能查到
npm view dsh-terminal-manager version dist-tags --registry=https://registry.npmjs.org

# ② 用全新 profile 真装一次（别拿自己的开发 profile 验证）
dsh plugin --profile verify-publish add dsh-terminal-manager@latest
dsh web --profile verify-publish --port 3180
#   浏览器打开 3180，确认左侧边栏出现「🖥️ 终端」按钮
dsh plugin --profile verify-publish remove dsh-terminal-manager
```

### 步骤 7：在 GitCode 上补 Release

GitCode 仓库 → **发布 → 新建发布**：选 `v0.1.1` 标签，写变更说明。Release 里**不再需要上传 tgz**（旧 tgz 通道已废弃，用户统一走 npm）。

---

## 三、回滚与排障

| 情况 | 处理 |
|---|---|
| 发出去了但发现严重 bug | 发更高的补丁版（npm 不允许覆盖已发布版本）。必须阻止别人安装时用 `npm deprecate dsh-terminal-manager@0.1.1 "原因"` |
| 发错了 dist-tag | `npm dist-tag add dsh-terminal-manager@0.1.0 latest --registry=https://registry.npmjs.org` 把 `latest` 指回稳定版 |
| 发布报 `E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required` | 两种可能：① **令牌建的时候没勾 Bypass 2FA**（默认未勾，`npm whoami` 仍会成功，所以最容易误判）→ 重建令牌并勾上；② 干脆用交互式验证码：`npm publish --registry=https://registry.npmjs.org --tag next --otp=<6 位动态码>`。**打包本身是成功的**（看到 `total files: 6` 就说明包没问题） |
| 发布报 402 / 403（不是上面那条） | 包名被占或令牌无权限；先确认 `npm whoami` 与令牌作用域 |
| 发布报 404 | 多半是发到了只读镜像源 —— 加上 `--registry=https://registry.npmjs.org` |
| 用户装不上刚发的版本 | 版本发布不足 24h，被 pnpm 的 `minimumReleaseAge` 拦了；等 24h 或让用户重跑一次 |
| 用户报 `Ignored build scripts: ssh2` | 让用户在 profile 目录跑 `pnpm approve-builds --all` 后重装 |

---

## 四、版本兼容性声明

当前 `devDependencies` 钉在 DSH `0.1.2-rc.1` 这条线，README 也声明支持该版本。DSH 升级（例如到 `0.1.5-*`）时插件需要：

1. 同步升级 `@deepseek-ai/*` 的 devDependencies；
2. 检查上游契约变更（历史教训：`dsh-host-apiproxy` 与 `dsh-client-runtime` 这两个包在 0.1.2-rc.1 里被上游删掉了，迁移映射见 [`docs/DHS-0.1.2-rc.1-契约迁移映射.zh.md`](docs/DHS-0.1.2-rc.1-契约迁移映射.zh.md)）；
3. 全量跑 `pnpm test` + E2E，并用全新 profile 真机挂载验证一次。

### 发布前自检清单

- [ ] `pnpm install` 干净通过（**不带任何参数**）
- [ ] `pnpm test` 621 项全绿
- [ ] `node scripts/run-e2e.mjs` 24/24 全绿
- [ ] `node scripts/mount-check.mjs` npm 通道真机挂载全绿
- [ ] `npm pack --dry-run` 清单只有 6 个文件
- [ ] 版本号已 bump，**且 `git show --stat HEAD` 里确实有 `package.json`**（实测踩过：提交信息写着「预发布 0.1.0-rc.1」，但那次提交只改了脚本、没改 `version`，结果发出去的仍是稳定版 `0.1.0`）
- [ ] 发布后用**全新 profile** 装过一次并真机验证
- [ ] GitCode 上补了对应 Release
