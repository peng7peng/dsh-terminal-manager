# DSH Terminal Manager 一键安装脚本 (Windows PowerShell)
# 用法: .\install.ps1 [-Profile <名称>] [-InstallDir <目录>]

param(
    [string]$Profile = "web",
    [string]$InstallDir = "",
    [switch]$Help
)

# 全局静默：pnpm/node 往 stderr 写进度信息，会被 PowerShell 当成错误显示
# 真正的错误通过 $LASTEXITCODE 检查
$ErrorActionPreference = "SilentlyContinue"

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Err($m)  { Write-Host "[ERROR] $m" -ForegroundColor Red }

if ($Help) {
    Write-Host @"
DSH Terminal Manager 一键安装 (Windows)

用法:
    .\install.ps1 [-Profile <名称>] [-InstallDir <目录>]

选项:
    -Profile       DSH Profile 名称（默认：web）
    -InstallDir    插件克隆目录（默认：~\.dsh\plugins）

"@
    exit 0
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DSH Terminal Manager 一键安装" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not $InstallDir) { $InstallDir = Join-Path $env:USERPROFILE ".dsh\plugins" }

# 1. 检查 Node.js
Write-Info "检查 Node.js..."
try {
    $nv = node --version 2>$null
    $major = [int]($nv -replace 'v(\d+).*','$1')
    if ($major -lt 22) { Write-Err "Node.js $nv 版本过低，需要 22+"; exit 1 }
    Write-Ok "Node.js $nv"
} catch {
    Write-Err "未找到 Node.js"
    Write-Host "请先安装 Node.js 22+：https://nodejs.org/"
    Write-Host "或 winget install OpenJS.NodeJS.LTS"
    exit 1
}

# 2. 检查 pnpm
Write-Info "检查 pnpm..."
$pnpmVer = pnpm --version 2>$null
if (-not $pnpmVer) {
    Write-Info "安装 pnpm..."
    npm install -g pnpm 2>$null
}
Write-Ok "pnpm $(pnpm --version 2>$null)"

# 3. 检查 dsh
Write-Info "检查 dsh..."
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Err "未找到 dsh 命令"
    Write-Host "请先安装 DeepSeek Harness："
    Write-Host "  npm install -g @deepseek-ai/dsh"
    Write-Host "或从源码安装：https://github.com/deepseek-ai/deepseek-harness"
    exit 1
}
Write-Ok "dsh $(dsh --version 2>$null)"

# 4. Clone 仓库
$PluginDir = Join-Path $InstallDir "dsh-terminal-manager"
if (Test-Path $PluginDir) {
    Write-Info "插件目录已存在，更新中..."
    Push-Location $PluginDir; git pull 2>&1 | Out-Null; Pop-Location
} else {
    Write-Info "克隆仓库到 $PluginDir ..."
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git $PluginDir 2>&1 | Out-Null
}
Write-Ok "仓库就绪"

# 5. 构建
Write-Info "安装依赖并构建..."
Push-Location $PluginDir
pnpm install | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install 失败"; Pop-Location; exit 1 }
pnpm build | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "pnpm build 失败"; Pop-Location; exit 1 }
Pop-Location
Write-Ok "构建完成"

# 6. 注册到 DSH profile
Write-Info "注册到 DSH profile: $Profile"
dsh plugin --profile $Profile add "dsh-terminal-manager@link:$PluginDir"
if ($LASTEXITCODE -ne 0) { Write-Err "注册失败"; exit 1 }
Write-Ok "安装完成"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "启动 DSH：" -ForegroundColor Cyan
Write-Host "  dsh $Profile"
Write-Host ""
Write-Host "更新插件：" -ForegroundColor Cyan
Write-Host "  cd $PluginDir; git pull; pnpm install; pnpm build"
Write-Host ""
