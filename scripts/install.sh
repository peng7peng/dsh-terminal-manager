#!/usr/bin/env bash
# DSH Terminal Manager 一键安装脚本 (Linux/macOS)
# 用法: ./install.sh [--plugin <路径>] [--profile <名称>]

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info() { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

show_help() {
    cat << 'EOF'
DSH Terminal Manager 一键安装脚本 (Linux/macOS)

用法:
    ./install.sh [选项]

选项:
    --plugin <路径>      插件 tgz 文件路径（默认：从 GitCode 下载最新版）
    --profile <名称>     DSH Profile 名称（默认：web）
    --skip-dsh           跳过 DSH 初始化（如果已安装）
    --help               显示此帮助信息

示例:
    ./install.sh                                    # 完整安装（DSH + 插件）
    ./install.sh --plugin ./dsh-terminal-manager-0.0.1.tgz  # 从本地 tgz 安装
    ./install.sh --skip-dsh                         # DSH 已装好，只装插件

EOF
    exit 0
}

# 解析参数
PLUGIN_PATH=""
PROFILE="web"
SKIP_DSH=false
DSH_HOME="${HOME}/.dsh"

while [[ $# -gt 0 ]]; do
    case $1 in
        --plugin)
            PLUGIN_PATH="$2"
            shift 2
            ;;
        --profile)
            PROFILE="$2"
            shift 2
            ;;
        --skip-dsh)
            SKIP_DSH=true
            shift
            ;;
        --help)
            show_help
            ;;
        *)
            error "未知参数: $1"
            show_help
            ;;
    esac
done

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  DSH Terminal Manager 一键安装脚本${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# ==================== 环境检查 ====================

# 检查 Node.js
info "检查 Node.js..."
if ! command -v node &> /dev/null; then
    error "未找到 Node.js"
    echo ""
    echo "请先安装 Node.js 22+ 或 24+："
    echo "  - 官网下载: https://nodejs.org/"
    echo "  - 或使用 nvm: nvm install 22"
    exit 1
fi
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
    warn "Node.js 版本过低: $NODE_VERSION（需要 22+）"
fi
success "Node.js $NODE_VERSION"

# 检查 npm（用于 npx）
info "检查 npm..."
if ! command -v npm &> /dev/null; then
    error "未找到 npm"
    exit 1
fi
success "npm $(npm --version)"

# ==================== DSH 初始化 ====================

if [ "$SKIP_DSH" = false ]; then
    if [ ! -d "$DSH_HOME" ]; then
        info "初始化 DSH 环境..."
        echo ""
        echo "首次运行 DSH 以初始化用户目录..."
        echo "（这会创建 ~/.dsh 目录和默认 profile）"
        echo ""

        # 运行 DSH 初始化（会创建 ~/.dsh）
        # 使用 timeout 避免阻塞，或者用户按 Ctrl+C 停止
        echo "正在启动 DSH，启动后请按 Ctrl+C 继续安装..."
        npx @deepseek-ai/dsh web --no-open &
        DSH_PID=$!

        # 等待 DSH 初始化（最多 30 秒）
        for i in {1..30}; do
            if [ -d "$DSH_HOME/profiles/web" ]; then
                sleep 2
                kill $DSH_PID 2>/dev/null || true
                wait $DSH_PID 2>/dev/null || true
                success "DSH 初始化完成"
                break
            fi
            sleep 1
        done

        if [ ! -d "$DSH_HOME/profiles/web" ]; then
            kill $DSH_PID 2>/dev/null || true
            error "DSH 初始化超时"
            echo ""
            echo "请手动运行以下命令初始化 DSH："
            echo "  npx @deepseek-ai/dsh web"
            echo "启动后按 Ctrl+C 停止，然后重新运行此脚本（加 --skip-dsh）"
            exit 1
        fi
    else
        success "DSH 已安装: $DSH_HOME"
    fi
else
    info "跳过 DSH 初始化"
fi

# 检查 Profile
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
info "Profile: $PROFILE -> $PROFILE_DIR"
if [ ! -d "$PROFILE_DIR" ]; then
    error "Profile 不存在: $PROFILE_DIR"
    warn "可用 Profiles:"
    ls -1 "$DSH_HOME/profiles" 2>/dev/null | while read -r dir; do
        [ -d "$DSH_HOME/profiles/$dir" ] && echo "  - $dir"
    done
    echo ""
    echo "请指定正确的 profile，例如："
    echo "  ./install.sh --profile web"
    exit 1
fi

# ==================== 获取插件 ====================

if [ -z "$PLUGIN_PATH" ]; then
    # 尝试从当前目录查找 tgz
    TGZ_FILE=$(ls dsh-terminal-manager-*.tgz 2>/dev/null | head -n 1)
    if [ -n "$TGZ_FILE" ]; then
        PLUGIN_PATH="$(pwd)/$TGZ_FILE"
        info "找到本地插件: $PLUGIN_PATH"
    else
        # 从 GitCode 下载最新版
        info "从 GitCode 下载插件..."
        DOWNLOAD_URL="https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.0.1/dsh-terminal-manager-0.0.1.tgz"

        if command -v curl &> /dev/null; then
            curl -L -o dsh-terminal-manager-0.0.1.tgz "$DOWNLOAD_URL"
        elif command -v wget &> /dev/null; then
            wget -O dsh-terminal-manager-0.0.1.tgz "$DOWNLOAD_URL"
        else
            error "需要 curl 或 wget 来下载插件"
            echo ""
            echo "请手动下载插件："
            echo "  $DOWNLOAD_URL"
            echo "然后使用 --plugin 参数指定路径"
            exit 1
        fi

        if [ ! -f "dsh-terminal-manager-0.0.1.tgz" ]; then
            error "下载失败"
            echo ""
            echo "请手动下载插件："
            echo "  $DOWNLOAD_URL"
            exit 1
        fi

        PLUGIN_PATH="$(pwd)/dsh-terminal-manager-0.0.1.tgz"
        success "插件已下载: $PLUGIN_PATH"
    fi
else
    if [ ! -f "$PLUGIN_PATH" ]; then
        error "插件文件不存在: $PLUGIN_PATH"
        exit 1
    fi
    PLUGIN_PATH="$(cd "$(dirname "$PLUGIN_PATH")" && pwd)/$(basename "$PLUGIN_PATH")"
fi

# ==================== 安装插件 ====================

info "安装插件到 Profile..."
cd "$PROFILE_DIR"

# 检查并移除旧版本
if [ -f "package.json" ]; then
    if grep -q '"dsh-terminal-manager"' package.json 2>/dev/null; then
        info "移除旧版本..."
        pnpm remove dsh-terminal-manager 2>/dev/null || true
    fi
fi

# 安装新版本（需要 pnpm）
if ! command -v pnpm &> /dev/null; then
    info "安装 pnpm..."
    npm install -g pnpm
fi

info "执行: pnpm add $PLUGIN_PATH"
pnpm add "$PLUGIN_PATH"
success "插件已安装"

# 更新 package.json 的 bundles
info "更新 bundles 配置..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!pkg.dsh) pkg.dsh = {};
if (!pkg.dsh.profile) pkg.dsh.profile = {};
if (!pkg.dsh.profile.bundles) pkg.dsh.profile.bundles = [];
if (!pkg.dsh.profile.bundles.includes('dsh-terminal-manager')) {
    pkg.dsh.profile.bundles.push('dsh-terminal-manager');
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('  已添加 dsh-terminal-manager 到 bundles');
} else {
    console.log('  dsh-terminal-manager 已在 bundles 中');
}
"

# ==================== 完成 ====================

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}启动 DSH：${NC}"
echo ""
echo "  npx @deepseek-ai/dsh $PROFILE"
echo ""
echo -e "${CYAN}然后：${NC}"
echo "  1. 打开浏览器访问 DSH 界面（默认 http://127.0.0.1:3080）"
echo "  2. 点击左侧边栏的「🖥️ 终端」按钮"
echo ""
echo -e "${YELLOW}遇到问题？${NC}"
echo "  - 文档: https://gitcode.com/pengpengR/dsh-terminal-manager"
echo "  - Issues: https://gitcode.com/pengpengR/dsh-terminal-manager/issues"
echo ""
