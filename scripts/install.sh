#!/usr/bin/env bash
# DSH Terminal Manager 一键安装脚本 (Linux/macOS)
# 用法: curl -fsSL https://gitcode.com/pengpengR/dsh-terminal-manager/raw/main/scripts/install.sh | bash
#   或: ./install.sh [--profile <名称>]
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }

PROFILE="web"
while [[ $# -gt 0 ]]; do case $1 in --profile) PROFILE="$2"; shift 2;; *) shift;; esac; done

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  DSH Terminal Manager 一键安装${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# 检查 Node.js
info "检查 Node.js..."
if ! command -v node &>/dev/null; then
    err "未找到 Node.js"
    echo "请先安装 Node.js 22+：https://nodejs.org/  或  nvm install 22"
    exit 1
fi
NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
    err "Node.js $NODE_VER 版本过低，需要 22+"
    exit 1
fi
ok "Node.js $NODE_VER"

# 检查 npx
if ! command -v npx &>/dev/null; then
    err "未找到 npx（需要 npm）"
    exit 1
fi

# 获取插件 tgz
PLUGIN_TGZ=""
TGZ_URL="https://gitcode.com/pengpengR/dsh-terminal-manager/releases/download/v0.1.0/dsh-terminal-manager-0.1.0.tgz"

# 优先检查本地 tgz
LOCAL_TGZ=$(ls dsh-terminal-manager-*.tgz 2>/dev/null | head -1)
if [ -n "$LOCAL_TGZ" ]; then
    PLUGIN_TGZ="$(pwd)/$LOCAL_TGZ"
    info "使用本地插件: $PLUGIN_TGZ"
else
    info "下载插件..."
    TMPDIR=$(mktemp -d)
    PLUGIN_TGZ="$TMPDIR/dsh-terminal-manager-0.1.0.tgz"
    if curl -fsSL -o "$PLUGIN_TGZ" "$TGZ_URL" 2>/dev/null; then
        ok "下载完成"
    else
        info "Release 未发布，改用 git 直接安装..."
        PLUGIN_TGZ=""
    fi
fi

# 安装
if [ -n "$PLUGIN_TGZ" ]; then
    info "安装: npx @deepseek-ai/dsh plugin --profile $PROFILE add $PLUGIN_TGZ"
    npx @deepseek-ai/dsh plugin --profile "$PROFILE" add "$PLUGIN_TGZ"
else
    info "安装: npx @deepseek-ai/dsh plugin --profile $PROFILE add git+https://gitcode.com/pengpengR/dsh-terminal-manager.git"
    npx @deepseek-ai/dsh plugin --profile "$PROFILE" add "git+https://gitcode.com/pengpengR/dsh-terminal-manager.git"
    echo ""
    echo -e "${YELLOW}[提示]${NC} git 安装需要在 profile 的 pnpm-workspace.yaml 中添加 allowBuilds："
    echo "  allowBuilds:"
    echo "    dsh-terminal-manager: true"
    echo "如果安装失败，请按提示配置后重试。"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}启动 DSH：${NC}"
echo "  npx @deepseek-ai/dsh $PROFILE"
echo ""
echo "浏览器会自动打开 http://127.0.0.1:3080"
echo "左侧边栏底部会出现「🖥️ 终端」按钮"
echo ""
