# DSH Terminal Manager 一键安装脚本 (Windows PowerShell)
# 用法: .\install.ps1 [-Profile <名称>] [-InstallDir <目录>]

param(
    [string]$Profile = "web",
    [string]$InstallDir = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Err($m)  { Write-Host "[ERROR] $m" -ForegroundColor Red }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

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
    $nv = node --version
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
try { $null = pnpm --version } catch {
    Write-Info "安装 pnpm..."
    npm install -g pnpm
}
Write-Ok "pnpm $(pnpm --version)"

# 3. Clone 仓库
$PluginDir = Join-Path $InstallDir "dsh-terminal-manager"
if (Test-Path $PluginDir) {
    Write-Info "插件目录已存在: $PluginDir"
    Write-Info "更新中..."
    Push-Location $PluginDir; git pull; Pop-Location
} else {
    Write-Info "克隆仓库到 $PluginDir ..."
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git $PluginDir
}
Write-Ok "仓库就绪"

# 4. 构建
Write-Info "安装依赖并构建..."
Push-Location $PluginDir
pnpm install
pnpm build
Pop-Location
Write-Ok "构建完成"

# 5. 打包 tgz
Write-Info "打包插件..."
Push-Location $PluginDir
$tgz = pnpm pack 2>$null | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1
$tgzPath = Join-Path $PluginDir $tgz
Pop-Location
if (-not (Test-Path $tgzPath)) {
    # Fallback: 查找 tgz 文件
    $tgzPath = Get-ChildItem -Path $PluginDir -Filter "dsh-terminal-manager-*.tgz" | Select-Object -First 1
    $tgzPath = $tgzPath.FullName
}
Write-Ok "打包完成: $tgzPath"

# 6. 安装到 DSH profile（用 tgz，避免 link: 依赖问题）
Write-Info "安装到 DSH profile: $Profile"
npx @deepseek-ai/dsh plugin --profile $Profile add $tgzPath
Write-Ok "安装完成"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "启动 DSH：" -ForegroundColor Cyan
Write-Host ""
Write-Host "  npx @deepseek-ai/dsh $Profile"
Write-Host ""
Write-Host "浏览器自动打开 http://127.0.0.1:3080"
Write-Host "左侧边栏底部出现「终端」按钮"
Write-Host ""
Write-Host "更新插件：" -ForegroundColor Cyan
Write-Host "  cd $PluginDir; git pull; pnpm install; pnpm build"
Write-Host "  然后重新运行此脚本"
Write-Host ""
