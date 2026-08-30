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

# 3. Clone 仓库
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

# 4. 构建
Write-Info "安装依赖并构建..."
Push-Location $PluginDir
pnpm install | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install 失败"; Pop-Location; exit 1 }
pnpm build | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Err "pnpm build 失败"; Pop-Location; exit 1 }
Pop-Location
Write-Ok "构建完成"

# 5. 打包 tgz
Write-Info "打包插件..."
Push-Location $PluginDir
pnpm pack | Out-Null
$tgzFile = Get-ChildItem -Path $PluginDir -Filter "dsh-terminal-manager-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$tgzPath = $tgzFile.FullName
Pop-Location
if (-not $tgzPath) { Write-Err "打包失败，未找到 tgz"; exit 1 }
Write-Ok "打包完成: $tgzPath"

# 6. 安装到 DSH profile
Write-Info "安装到 DSH profile: $Profile"

# 预写 allowBuilds 配置（pnpm ≥10 需要批准原生模块构建）
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (Test-Path $profileDir) {
    $wsFile = Join-Path $profileDir "pnpm-workspace.yaml"
    $allowBuildsContent = @"
allowBuilds:
  ssh2: true
  cpu-features: true
  dsh-terminal-manager: true
"@
    if (Test-Path $wsFile) {
        # 文件已存在：只在缺少 allowBuilds 时追加，避免覆盖 packages 等配置
        $existing = Get-Content $wsFile -Raw
        if (-not ($existing -match "allowBuilds:")) {
            Add-Content -Path $wsFile -Value "" -Encoding UTF8
            Add-Content -Path $wsFile -Value $allowBuildsContent -Encoding UTF8
        }
    } else {
        # 文件不存在，新建
        Set-Content -Path $wsFile -Value $allowBuildsContent -Encoding UTF8
    }
    Write-Info "已配置 allowBuilds: $wsFile"
}

$installed = $false

# 方式 A：全局安装了 dsh
if (Get-Command dsh -ErrorAction SilentlyContinue) {
    Write-Info "使用全局 dsh 命令"
    dsh plugin --profile $Profile add $tgzPath
    $installed = ($LASTEXITCODE -eq 0)
}

# 方式 B：查找 deepseek-harness 源码（多处搜索）
if (-not $installed) {
    $searchPaths = @(
        # 脚本所在目录的相邻目录（从源码 clone 运行时）
        (Join-Path (Split-Path $PSScriptRoot -Parent) "deepseek-harness"),
        # 当前工作目录的相邻目录
        (Join-Path (Split-Path (Get-Location) -Parent) "deepseek-harness"),
        # 插件安装目录的相邻目录
        (Join-Path (Split-Path (Split-Path $PluginDir -Parent) -Parent) "deepseek-harness"),
        # 常见位置
        "D:\dsh\deepseek-harness",
        "D:\myproject\dsh\deepseek-harness",
        "$env:USERPROFILE\deepseek-harness"
    ) | Select-Object -Unique

    foreach ($path in $searchPaths) {
        if (Test-Path (Join-Path $path "package.json")) {
            Write-Info "检测到 DSH 源码: $path"
            Push-Location $path
            pnpm dsh plugin --profile $Profile add $tgzPath
            $installed = ($LASTEXITCODE -eq 0)
            Pop-Location
            break
        }
    }
}

# 方式 C：用 npx（兜底）
if (-not $installed -and (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Info "使用 npx @deepseek-ai/dsh（首次需下载）"
    npx @deepseek-ai/dsh plugin --profile $Profile add $tgzPath
    $installed = ($LASTEXITCODE -eq 0)
}

if (-not $installed) {
    Write-Err "安装失败。请确保已安装 DSH：npm install -g @deepseek-ai/dsh"
    exit 1
}
Write-Ok "安装完成"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "启动 DSH：" -ForegroundColor Cyan
Write-Host ""
Write-Host "  dsh $Profile"
Write-Host ""
Write-Host "浏览器自动打开 http://127.0.0.1:3080"
Write-Host "左侧边栏底部出现「终端」按钮"
Write-Host ""
Write-Host "更新插件：" -ForegroundColor Cyan
Write-Host "  cd $PluginDir; git pull; pnpm install; pnpm build"
Write-Host "  然后重新运行此脚本"
Write-Host ""
