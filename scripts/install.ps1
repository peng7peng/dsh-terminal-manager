# DSH Terminal Manager 一键安装脚本 (Windows PowerShell)
# 用法: .\install.ps1 [-PluginPath <路径>] [-Profile <profile名称>] [-DshHome <DSH目录>]

param(
    [string]$PluginPath = "",
    [string]$Profile = "web",
    [string]$DshHome = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-Info { param($Msg) Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Error { param($Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Warn { param($Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }

function Show-Help {
    Write-Host @"
DSH Terminal Manager 安装脚本 (Windows)

用法:
    .\install.ps1 [选项]

选项:
    -PluginPath <路径>    插件 tgz 文件路径（默认：当前目录下的 dsh-terminal-manager-*.tgz）
    -Profile <名称>       DSH Profile 名称（默认：web）
    -DshHome <路径>       deepseek-harness 源码目录（可选，用于验证安装）
    -Help                 显示此帮助信息

示例:
    .\install.ps1
    .\install.ps1 -PluginPath ".\dsh-terminal-manager-0.0.1.tgz"
    .\install.ps1 -Profile "tm-dev" -DshHome "D:\myProject\dsh\deepseek-harness"

"@
    exit 0
}

if ($Help) { Show-Help }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DSH Terminal Manager 安装脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
Write-Info "检查 Node.js..."
try {
    $nodeVersion = node --version
    Write-Success "Node.js $nodeVersion"
} catch {
    Write-Error "未找到 Node.js，请先安装 Node.js 22+ 或 24+"
    Write-Host "下载: https://nodejs.org/"
    exit 1
}

# 检查 pnpm
Write-Info "检查 pnpm..."
try {
    $pnpmVersion = pnpm --version
    Write-Success "pnpm $pnpmVersion"
} catch {
    Write-Error "未找到 pnpm，请先安装 pnpm 11+"
    Write-Host "安装: npm install -g pnpm"
    exit 1
}

# 确定 DSH Home
if ([string]::IsNullOrEmpty($DshHome)) {
    $DshHome = Join-Path $env:USERPROFILE ".dsh"
}
Write-Info "DSH Home: $DshHome"

if (-not (Test-Path $DshHome)) {
    Write-Error "DSH Home 不存在: $DshHome"
    Write-Warn "请先安装 DSH (deepseek-harness)"
    exit 1
}

# 确定 Profile 目录
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
Write-Info "Profile: $Profile -> $ProfileDir"

if (-not (Test-Path $ProfileDir)) {
    Write-Error "Profile 不存在: $ProfileDir"
    Write-Warn "可用 Profiles:"
    Get-ChildItem (Join-Path $DshHome "profiles") -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

# 查找插件文件
if ([string]::IsNullOrEmpty($PluginPath)) {
    # 在当前目录查找 tgz
    $tgzFiles = Get-ChildItem -Path "." -Filter "dsh-terminal-manager-*.tgz" -ErrorAction SilentlyContinue
    if ($tgzFiles.Count -eq 0) {
        Write-Error "未找到插件 tgz 文件"
        Write-Host ""
        Write-Host "请用 -PluginPath 指定插件文件路径，例如："
        Write-Host "    .\install.ps1 -PluginPath `".\dsh-terminal-manager-0.0.1.tgz`""
        exit 1
    }
    $PluginPath = $tgzFiles[0].FullName
    Write-Info "找到插件: $PluginPath"
} else {
    if (-not (Test-Path $PluginPath)) {
        Write-Error "插件文件不存在: $PluginPath"
        exit 1
    }
    $PluginPath = (Resolve-Path $PluginPath).Path
}

# 安装插件
Write-Info "安装插件到 Profile..."
Push-Location $ProfileDir
try {
    # 先移除旧版本（如果有）
    $pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    if ($pkgJson.dependencies.'dsh-terminal-manager') {
        Write-Info "移除旧版本..."
        pnpm remove dsh-terminal-manager 2>$null
    }

    # 安装新版本
    Write-Info "执行: pnpm add $PluginPath"
    pnpm add $PluginPath
    Write-Success "插件已安装"

    # 更新 package.json 的 bundles
    Write-Info "更新 bundles 配置..."
    $pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json

    if (-not $pkgJson.dsh) {
        $pkgJson | Add-Member -NotePropertyName "dsh" -NotePropertyValue @{ profile = @{ bundles = @() } }
    }
    if (-not $pkgJson.dsh.profile) {
        $pkgJson.dsh | Add-Member -NotePropertyName "profile" -NotePropertyValue @{ bundles = @() }
    }
    if (-not $pkgJson.dsh.profile.bundles) {
        $pkgJson.dsh.profile | Add-Member -NotePropertyName "bundles" -NotePropertyValue @()
    }

    $bundles = [System.Collections.ArrayList]@($pkgJson.dsh.profile.bundles)
    if (-not $bundles.Contains("dsh-terminal-manager")) {
        $bundles.Add("dsh-terminal-manager") | Out-Null
        $pkgJson.dsh.profile.bundles = $bundles.ToArray()

        # 写回 package.json
        $pkgJson | ConvertTo-Json -Depth 10 | Set-Content "package.json" -Encoding UTF8
        Write-Success "已添加 dsh-terminal-manager 到 bundles"
    } else {
        Write-Info "dsh-terminal-manager 已在 bundles 中"
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 启动 DSH:"
Write-Host "     cd <deepseek-harness 目录>"
Write-Host "     pnpm dsh --profile $Profile"
Write-Host ""
Write-Host "  2. 打开浏览器访问 DSH 界面"
Write-Host "  3. 点击左侧边栏的「🖥️ 终端」按钮"
Write-Host ""
Write-Host "如遇到问题，请查看: INSTALL.zh.md" -ForegroundColor Yellow
