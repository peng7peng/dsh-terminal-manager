#!/usr/bin/env bash
# DSH Terminal Manager 一键安装脚本 (Linux/macOS)
# 用法: ./install.sh [--plugin <路径>] [--profile <名称>] [--dsh-home <路径>]

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
DSH Terminal Manager 安装脚本 (Linux/macOS)

用法:
    ./install.sh [选项]

选项:
    --plugin <路径>      插件 tgz 文件路径（默认：当前目录下的 dsh-terminal-manager-*.tgz）
    --profile <名称>     DSH Profile 名称（默认：web）
    --dsh-home <路径>    DSH 用户数据目录（默认：~/.dsh）
    --help               显示此帮助信息

示例:
    ./install.sh
    ./install.sh --plugin ./dsh-terminal-manager-0.0.1.tgz
    ./install.sh --profile tm-dev --dsh-home ~/.dsh

EOF
    exit 0
}

# 解析参数
PLUGIN_PATH=""
PROFILE="web"
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
        --dsh-home)
            DSH_HOME="$2"
            shift 2
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
echo -e "${CYAN}  DSH Terminal Manager 安装脚本${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# 检查 Node.js
info "检查 Node.js..."
if ! command -v node &> /dev/null; then
    error "未找到 Node.js，请先安装 Node.js 22+ 或 24+"
    echo "下载: https://nodejs.org/"
    exit 1
fi
NODE_VERSION=$(node --version)
success "Node.js $NODE_VERSION"

# 检查 pnpm
info "检查 pnpm..."
if ! command -v pnpm &> /dev/null; then
    error "未找到 pnpm，请先安装 pnpm 11+"
    echo "安装: npm install -g pnpm"
    exit 1
fi
PNPM_VERSION=$(pnpm --version)
success "pnpm $PNPM_VERSION"

# 检查 DSH Home
info "DSH Home: $DSH_HOME"
if [ ! -d "$DSH_HOME" ]; then
    error "DSH Home 不存在: $DSH_HOME"
    warn "请先安装 DSH (deepseek-harness)"
    exit 1
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
    exit 1
fi

# 查找插件文件
if [ -z "$PLUGIN_PATH" ]; then
    # 在当前目录查找 tgz
    TGZ_FILE=$(ls dsh-terminal-manager-*.tgz 2>/dev/null | head -n 1)
    if [ -z "$TGZ_FILE" ]; then
        error "未找到插件 tgz 文件"
        echo ""
        echo "请用 --plugin 指定插件文件路径，例如："
        echo "    ./install.sh --plugin ./dsh-terminal-manager-0.0.1.tgz"
        exit 1
    fi
    PLUGIN_PATH="$(pwd)/$TGZ_FILE"
    info "找到插件: $PLUGIN_PATH"
else
    if [ ! -f "$PLUGIN_PATH" ]; then
        error "插件文件不存在: $PLUGIN_PATH"
        exit 1
    fi
    # 转为绝对路径
    PLUGIN_PATH="$(cd "$(dirname "$PLUGIN_PATH")" && pwd)/$(basename "$PLUGIN_PATH")"
fi

# 安装插件
info "安装插件到 Profile..."
cd "$PROFILE_DIR"

# 检查并移除旧版本
if [ -f "package.json" ]; then
    if grep -q '"dsh-terminal-manager"' package.json 2>/dev/null; then
        info "移除旧版本..."
        pnpm remove dsh-terminal-manager 2>/dev/null || true
    fi
fi

# 安装新版本
info "执行: pnpm add $PLUGIN_PATH"
pnpm add "$PLUGIN_PATH"
success "插件已安装"

# 更新 package.json 的 bundles
info "更新 bundles 配置..."
if command -v node &> /dev/null; then
    node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!pkg.dsh) pkg.dsh = {};
if (!pkg.dsh.profile) pkg.dsh.profile = {};
if (!pkg.dsh.profile.bundles) pkg.dsh.profile.bundles = [];
if (!pkg.dsh.profile.bundles.includes('dsh-terminal-manager')) {
    pkg.dsh.profile.bundles.push('dsh-terminal-manager');
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('已添加 dsh-terminal-manager 到 bundles');
} else {
    console.log('dsh-terminal-manager 已在 bundles 中');
}
"
else
    warn "无法自动更新 bundles，请手动编辑 package.json"
    warn "确保 dsh.profile.bundles 包含 \"dsh-terminal-manager\""
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}下一步：${NC}"
echo "  1. 启动 DSH:"
echo "     cd <deepseek-harness 目录>"
echo "     pnpm dsh --profile $PROFILE"
echo ""
echo "  2. 打开浏览器访问 DSH 界面"
echo "  3. 点击左侧边栏的「🖥️ 终端」按钮"
echo ""
echo -e "${YELLOW}如遇到问题，请查看: INSTALL.zh.md${NC}"
