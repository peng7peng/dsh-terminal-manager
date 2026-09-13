# DSH Terminal Manager 安装脚本 (Windows PowerShell)
#
# 用法:
#   .\install.ps1                              # npm 安装（推荐，普通用户）
#   .\install.ps1 -Profile tm-dev              # 装到指定 profile
#   .\install.ps1 -FromSource                  # 源码安装：clone + 构建 + link（开发者）
#   .\install.ps1 -FromSource -SourceDir D:\code\dsh-terminal-manager
#
# 说明：npm 安装走 `dsh plugin --profile <p> add dsh-terminal-manager@latest`，
# 脚本只负责找一个可用的 dsh 入口（全局 dsh / DSH 源码 checkout / npx 兜底）。

param(
    [string]$Profile = 'web',
    [switch]$FromSource,
    [string]$SourceDir = (Join-Path $env:USERPROFILE 'dsh-terminal-manager')
)

$RepoUrl = 'https://gitcode.com/pengpengR/dsh-terminal-manager.git'

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Err($m)  { Write-Host "[ERROR] $m" -ForegroundColor Red }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

function Test-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# 找一个能用的 dsh 入口执行 `plugin` 子命令；找不到返回 $false。
function Invoke-DshPlugin {
    param([string[]]$DshArgs)

    if (Test-Command 'dsh') {
        Write-Info '使用全局 dsh 命令'
        & dsh @DshArgs
        return ($LASTEXITCODE -eq 0)
    }

    # DSH 源码 checkout：在它目录下用 `pnpm dsh` 启动
    $candidates = @(
        (Join-Path (Split-Path $PSScriptRoot -Parent) '..\deepseek-harness'),
        (Join-Path (Get-Location) '..\deepseek-harness'),
        'D:\myProject\dsh\deepseek-harness',
        (Join-Path $env:USERPROFILE 'deepseek-harness')
    ) | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique

    foreach ($root in $candidates) {
        if ((Test-Path (Join-Path $root 'package.json')) -and (Test-Command 'pnpm')) {
            Write-Info "检测到 DSH 源码：$root"
            Push-Location $root
            pnpm dsh @DshArgs
            $ok = ($LASTEXITCODE -eq 0)
            Pop-Location
            return $ok
        }
    }

    if (Test-Command 'npx') {
        Write-Info '退回 npx（首次需下载）'
        npx -y --package '@deepseek-ai/dsh' dsh @DshArgs
        return ($LASTEXITCODE -eq 0)
    }
    return $false
}

# ---------- 0. 环境检查 ----------
Write-Info '检查 Node.js...'
if (-not (Test-Command 'node')) { Write-Err '未找到 node，请先安装 Node.js 22+：https://nodejs.org/'; exit 1 }
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Write-Warn "Node.js 版本偏低（$(node --version)），建议 22+" }
Write-Ok "Node.js $(node --version)"

if (-not (Test-Command 'pnpm')) {
    Write-Info '安装 pnpm...'
    npm install -g pnpm
    if (-not (Test-Command 'pnpm')) { Write-Err 'pnpm 安装失败，请手动执行 npm install -g pnpm'; exit 1 }
}
Write-Ok "pnpm $(pnpm --version)"

# ---------- 1. 决定安装目标 ----------
if ($FromSource) {
    Write-Info "源码安装模式，目标目录：$SourceDir"
    if (Test-Path (Join-Path $SourceDir '.git')) {
        Write-Info '仓库已存在，拉取更新...'
        git -C $SourceDir pull --ff-only
    } else {
        git clone $RepoUrl $SourceDir
        if ($LASTEXITCODE -ne 0) { Write-Err "git clone 失败：$RepoUrl"; exit 1 }
    }

    Push-Location $SourceDir
    Write-Info '安装依赖...'; pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Err 'pnpm install 失败'; Pop-Location; exit 1 }
    Write-Info '构建...'; pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Err 'pnpm build 失败'; Pop-Location; exit 1 }
    Pop-Location

    $target = "dsh-terminal-manager@link:$SourceDir"
} else {
    $target = 'dsh-terminal-manager@latest'
}

# ---------- 2. 装进 profile ----------
Write-Info "安装 $target 到 profile「$Profile」..."
$ok = Invoke-DshPlugin @('plugin', '--profile', $Profile, 'add', $target)

if (-not $ok) {
    Write-Err '安装失败。排查建议：'
    Write-Host '  1) 确认 DSH 已安装：npm install -g @deepseek-ai/dsh'
    Write-Host "  2) 确认 profile 存在：先跑一次 dsh web --profile $Profile"
    Write-Host "  3) ssh2 构建脚本被拦：在 ~/.dsh/profiles/$Profile 下跑 pnpm approve-builds --all 后重试"
    exit 1
}

Write-Ok '安装完成'
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1) 启动 DSH：dsh web'
Write-Host '  2) 浏览器硬刷新（Ctrl+Shift+R），左侧边栏底部出现「🖥️ 终端」按钮'
Write-Host ''
if ($FromSource) {
    Write-Host '源码模式：改完代码后重建即可生效：' -ForegroundColor Cyan
    Write-Host "  cd $SourceDir; pnpm build"
}
