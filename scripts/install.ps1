# DSH Terminal Manager 一键安装脚本 (Windows PowerShell)
# 用法: irm https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.ps1 | iex
#   或: .\install.ps1 [-Profile <名称>]

param(
    [string]$Profile = "web",
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
    .\install.ps1 [-Profile <名称>]

选项:
    -Profile    DSH Profile 名称（默认：web）

"@
    exit 0
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DSH Terminal Manager 一键安装" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
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

# 检查 npx
try { $null = npx --version } catch { Write-Err "未找到 npx"; exit 1 }

# 获取插件 tgz
$PluginPath = ""
$TgzUrl = "https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.1.0/dsh-terminal-manager-0.1.0.tgz"

# 优先检查本地 tgz
$localTgz = Get-ChildItem -Path "." -Filter "dsh-terminal-manager-*.tgz" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($localTgz) {
    $PluginPath = (Resolve-Path $localTgz.FullName).Path
    Write-Info "使用本地插件: $PluginPath"
} else {
    Write-Info "下载插件..."
    $tmpDir = Join-Path $env:TEMP "dsh-tm-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $PluginPath = Join-Path $tmpDir "dsh-terminal-manager-0.1.0.tgz"
    try {
        Invoke-WebRequest -Uri $TgzUrl -OutFile $PluginPath -UseBasicParsing
        Write-Ok "下载完成"
    } catch {
        Write-Info "Release 未发布，改用 git 直接安装..."
        $PluginPath = ""
    }
}

# 安装
if ($PluginPath) {
    Write-Info "安装: npx @deepseek-ai/dsh plugin --profile $Profile add $PluginPath"
    npx @deepseek-ai/dsh plugin --profile $Profile add $PluginPath
} else {
    Write-Info "安装: npx @deepseek-ai/dsh plugin --profile $Profile add git+https://gitcode.com/pengpengR/dsh-terminal-manager.git"
    npx @deepseek-ai/dsh plugin --profile $Profile add "git+https://gitcode.com/pengpengR/dsh-terminal-manager.git"
    Write-Host ""
    Write-Warn "git 安装需要在 profile 的 pnpm-workspace.yaml 中添加 allowBuilds："
    Write-Host "  allowBuilds:"
    Write-Host "    dsh-terminal-manager: true"
    Write-Host "如果安装失败，请按提示配置后重试。"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "启动 DSH：" -ForegroundColor Cyan
Write-Host ""
Write-Host "  npx @deepseek-ai/dsh $Profile"
Write-Host ""
Write-Host "浏览器会自动打开 http://127.0.0.1:3080"
Write-Host "左侧边栏底部会出现「终端」按钮"
Write-Host ""
