#!/usr/bin/env bash
# DSH Terminal Manager 一键安装脚本 (Linux/macOS)
# 用法: ./install.sh [--profile <名称>] [--dir <安装目录>]
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }

PROFILE="web"
INSTALL_DIR="$HOME/.dsh/plugins"
while [[ $# -gt 0 ]]; do
    case $1 in
        --profile) PROFILE="$2"; shift 2;;
        --dir) INSTALL_DIR="$2"; shift 2;;
        *) shift;;
    esac
done

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  DSH Terminal Manager 一键安装${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# 1. 检查 Node.js
info "检查 Node.js..."
if ! command -v node &>/dev/null; then
    err "未找到 Node.js"; echo "请先安装 Node.js 22+：https://nodejs.org/"; exit 1
fi
NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then err "Node.js $NODE_VER 版本过低，需要 22+"; exit 1; fi
ok "Node.js $NODE_VER"

# 2. 检查 pnpm
info "检查 pnpm..."
if ! command -v pnpm &>/dev/null; then info "安装 pnpm..."; npm install -g pnpm; fi
ok "pnpm $(pnpm --version)"

# 3. Clone 仓库
PLUGIN_DIR="$INSTALL_DIR/dsh-terminal-manager"
if [ -d "$PLUGIN_DIR" ]; then
    info "插件目录已存在，更新中..."
    cd "$PLUGIN_DIR" && git pull
else
    info "克隆仓库到 $PLUGIN_DIR ..."
    mkdir -p "$INSTALL_DIR"
    git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git "$PLUGIN_DIR"
fi
ok "仓库就绪"

# 4. 构建
info "安装依赖并构建..."
cd "$PLUGIN_DIR"
pnpm install
pnpm build
ok "构建完成"

# 5. 打包 tgz
info "打包插件..."
TGZ=$(pnpm pack 2>/dev/null | grep '\.tgz$' | tail -1)
TGZ_PATH="$PLUGIN_DIR/$TGZ"
ok "打包完成: $TGZ_PATH"

# 6. 安装到 DSH profile（tgz 方式，确保模块解析正确）
info "安装到 DSH profile: $Profile"
npx @deepseek-ai/dsh plugin --profile "$PROFILE" add "$TGZ_PATH"
ok "安装完成"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}启动 DSH：${NC}"
echo "  npx @deepseek-ai/dsh $PROFILE"
echo ""
echo "浏览器自动打开 http://127.0.0.1:3080"
echo "左侧边栏底部出现「🖥️ 终端」按钮"
echo ""
echo -e "${CYAN}更新插件：${NC}"
echo "  cd $PLUGIN_DIR && git pull && pnpm install && pnpm build"
echo "  然后重新运行此脚本"
echo ""
