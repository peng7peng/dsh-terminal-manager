# DSH Terminal Manager 一键安装脚本 (Windows PowerShell)
# 用法: .\install.ps1 [-PluginPath <路径>] [-Profile <名称>] [-SkipDsh]

param(
    [string]$PluginPath = "",
    [string]$Profile = "web",
    [switch]$SkipDsh,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-Info { param($Msg) Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Success { param($Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Error { param($Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Warn { param($Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }

function Show-Help {
    Write-Host @"
DSH Terminal Manager 一键安装脚本 (Windows)

用法:
    .\install.ps1 [选项]

选项:
    -PluginPath <路径>    插件 tgz 文件路径（默认：从 GitCode 下载最新版）
    -Profile <名称>       DSH Profile 名称（默认：web）
    -SkipDsh              跳过 DSH 初始化（如果已安装）
    -Help                 显示此帮助信息

示例:
    .\install.ps1                                    # 完整安装（DSH + 插件）
    .\install.ps1 -PluginPath ".\dsh-terminal-manager-0.0.1.tgz"
    .\install.ps1 -SkipDsh                           # DSH 已装好，只装插件

"@
    exit 0
}

if ($Help) { Show-Help }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DSH Terminal Manager 一键安装脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$DshHome = Join-Path $env:USERPROFILE ".dsh"

# ==================== 环境检查 ====================

# 检查 Node.js
Write-Info "检查 Node.js..."
try {
    $nodeVersion = node --version
    $nodeMajor = [int]($nodeVersion -replace 'v(\d+).*', '$1')
    if ($nodeMajor -lt 22) {
        Write-Warn "Node.js 版本过低: $nodeVersion（需要 22+）"
    }
    Write-Success "Node.js $nodeVersion"
} catch {
    Write-Error "未找到 Node.js"
    Write-Host ""
    Write-Host "请先安装 Node.js 22+ 或 24+："
    Write-Host "  - 官网下载: https://nodejs.org/"
    Write-Host "  - 或使用 winget: winget install OpenJS.NodeJS.LTS"
    exit 1
}

# 检查 npm
Write-Info "检查 npm..."
try {
    $npmVersion = npm --version
    Write-Success "npm $npmVersion"
} catch {
    Write-Error "未找到 npm"
    exit 1
}

# ==================== DSH 初始化 ====================

if (-not $SkipDsh) {
    if (-not (Test-Path $DshHome)) {
        Write-Info "初始化 DSH 环境..."
        Write-Host ""
        Write-Host "首次运行 DSH 以初始化用户目录..."
        Write-Host "（这会创建 ~/.dsh 目录和默认 profile）"
        Write-Host ""

        # 启动 DSH 进行初始化
        Write-Host "正在启动 DSH，启动后请按 Ctrl+C 继续安装..."
        $dshProcess = Start-Process -FilePath "npx" -ArgumentList "@deepseek-ai/dsh web --no-open" -PassThru -NoNewWindow

        # 等待 DSH 初始化（最多 30 秒）
        $initialized = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if (Test-Path (Join-Path $DshHome "profiles\web")) {
                Start-Sleep -Seconds 2
                $initialized = $true
                break
            }
        }

        # 停止 DSH 进程
        try {
            Stop-Process -Id $dshProcess.Id -Force -ErrorAction SilentlyContinue
        } catch {}

        if (-not $initialized) {
            Write-Error "DSH 初始化超时"
            Write-Host ""
            Write-Host "请手动运行以下命令初始化 DSH："
            Write-Host "  npx @deepseek-ai/dsh web"
            Write-Host "启动后按 Ctrl+C 停止，然后重新运行此脚本（加 -SkipDsh）"
            exit 1
        }
        Write-Success "DSH 初始化完成"
    } else {
        Write-Success "DSH 已安装: $DshHome"
    }
} else {
    Write-Info "跳过 DSH 初始化"
}

# 检查 Profile
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
Write-Info "Profile: $Profile -> $ProfileDir"
if (-not (Test-Path $ProfileDir)) {
    Write-Error "Profile 不存在: $ProfileDir"
    Write-Warn "可用 Profiles:"
    Get-ChildItem (Join-Path $DshHome "profiles") -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    Write-Host ""
    Write-Host "请指定正确的 profile，例如："
    Write-Host "  .\install.ps1 -Profile web"
    exit 1
}

# ==================== 获取插件 ====================

if ([string]::IsNullOrEmpty($PluginPath)) {
    # 尝试从当前目录查找 tgz
    $tgzFiles = Get-ChildItem -Path "." -Filter "dsh-terminal-manager-*.tgz" -ErrorAction SilentlyContinue
    if ($tgzFiles.Count -gt 0) {
        $PluginPath = $tgzFiles[0].FullName
        Write-Info "找到本地插件: $PluginPath"
    } else {
        # 从 GitCode 下载最新版
        Write-Info "从 GitCode 下载插件..."
        $downloadUrl = "https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.0.1/dsh-terminal-manager-0.0.1.tgz"
        $PluginPath = Join-Path (Get-Location) "dsh-terminal-manager-0.0.1.tgz"

        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $PluginPath -UseBasicParsing
            Write-Success "插件已下载: $PluginPath"
        } catch {
            Write-Error "下载失败: $_"
            Write-Host ""
            Write-Host "请手动下载插件："
            Write-Host "  $downloadUrl"
            Write-Host "然后使用 -PluginPath 参数指定路径"
            exit 1
        }
    }
} else {
    if (-not (Test-Path $PluginPath)) {
        Write-Error "插件文件不存在: $PluginPath"
        exit 1
    }
    $PluginPath = (Resolve-Path $PluginPath).Path
}

# ==================== 安装插件 ====================

Write-Info "安装插件到 Profile..."
Push-Location $ProfileDir
try {
    # 检查并移除旧版本
    if (Test-Path "package.json") {
        $pkgContent = Get-Content "package.json" -Raw
        if ($pkgContent -match '"dsh-terminal-manager"') {
            Write-Info "移除旧版本..."
            pnpm remove dsh-terminal-manager 2>$null
        }
    }

    # 安装 pnpm（如果没有）
    try {
        $null = pnpm --version
    } catch {
        Write-Info "安装 pnpm..."
        npm install -g pnpm
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

# ==================== 完成 ====================

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "启动 DSH：" -ForegroundColor Cyan
Write-Host ""
Write-Host "  npx @deepseek-ai/dsh $Profile"
Write-Host ""
Write-Host "然后：" -ForegroundColor Cyan
Write-Host "  1. 打开浏览器访问 DSH 界面（默认 http://127.0.0.1:3080）"
Write-Host "  2. 点击左侧边栏的「🖥️ 终端」按钮"
Write-Host ""
Write-Host "遇到问题？" -ForegroundColor Yellow
Write-Host "  - 文档: https://gitcode.com/pengpengR/dsh-terminal-manager"
Write-Host "  - Issues: https://gitcode.com/pengpengR/dsh-terminal-manager/issues"
Write-Host ""
