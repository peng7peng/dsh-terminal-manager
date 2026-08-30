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

# 从 tgz 中剥离 devDependencies（link: 路径在 profile 环境不可用，且会触发 symlink 失败）
EXTRACT_DIR=$(mktemp -d)
(cd "$EXTRACT_DIR" && tar -xzf "$TGZ_PATH" 2>/dev/null)
if [ -f "$EXTRACT_DIR/package/package.json" ]; then
    EXTRACT_DIR="$EXTRACT_DIR" node -e "
const fs = require('fs');
const path = process.env.EXTRACT_DIR + '/package/package.json';
const p = JSON.parse(fs.readFileSync(path, 'utf8'));
delete p.devDependencies;
fs.writeFileSync(path, JSON.stringify(p, null, 2));
"
    rm -f "$TGZ_PATH"
    tar -czf "$TGZ_PATH" -C "$EXTRACT_DIR" package
    info "已剥离 devDependencies"
fi
rm -rf "$EXTRACT_DIR"

ok "打包完成: $TGZ_PATH"

# 6. 安装到 DSH profile（自动检测 dsh / pnpm dsh / npx）
info "安装到 DSH profile: $PROFILE"

# 预写 allowBuilds 配置（pnpm ≥10 需要批准原生模块构建）
# 关键：allowBuilds 的 key 必须是 `包名@file:相对路径` 完整形式
# （参考 deepseek-harness 的 pnpm-workspace.yaml）
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
if [ -d "$PROFILE_DIR" ]; then
    WS_FILE="$PROFILE_DIR/pnpm-workspace.yaml"
    # tgz 相对 profile 目录的路径（固定结构：.dsh/profiles/<name> vs .dsh/plugins/<name>）
    TZX_REL_PATH="../../plugins/dsh-terminal-manager/dsh-terminal-manager-0.1.0.tgz"
    if [ -f "$WS_FILE" ]; then
        # 文件已存在：只在缺少 allowBuilds 时追加，避免覆盖 packages 等配置
        if ! grep -q "^allowBuilds:" "$WS_FILE"; then
            {
                echo ""
                echo "allowBuilds:"
                echo "  ssh2: true"
                echo "  cpu-features: true"
                echo "  'dsh-terminal-manager@file:$TZX_REL_PATH': true"
            } >> "$WS_FILE"
        fi
    else
        # 文件不存在，新建
        cat > "$WS_FILE" << EOF
allowBuilds:
  ssh2: true
  cpu-features: true
  'dsh-terminal-manager@file:$TZX_REL_PATH': true
EOF
    fi
    info "已配置 allowBuilds: $WS_FILE"
fi

# 设置 ignore-scripts=true，避免安装 tgz 时触发脚本（tgz 已包含构建产物）
NPMRC_FILE="$PROFILE_DIR/.npmrc"
if [ -f "$NPMRC_FILE" ]; then
    if ! grep -q "ignore-scripts" "$NPMRC_FILE"; then
        echo "ignore-scripts=true" >> "$NPMRC_FILE"
    fi
else
    echo "ignore-scripts=true" > "$NPMRC_FILE"
fi
info "已配置 ignore-scripts: $NPMRC_FILE"

installed=false

if command -v dsh &>/dev/null; then
    info "使用全局 dsh 命令"
    dsh plugin --profile "$PROFILE" add "$TGZ_PATH" && installed=true
fi

if [ "$installed" = false ]; then
    # 搜索 deepseek-harness 源码
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    SEARCH_PATHS=(
        "$SCRIPT_DIR/../deepseek-harness"
        "$(pwd)/../deepseek-harness"
        "$(dirname "$INSTALL_DIR")/../deepseek-harness"
        "$HOME/deepseek-harness"
    )
    for path in "${SEARCH_PATHS[@]}"; do
        path="$(realpath "$path" 2>/dev/null || echo "$path")"
        if [ -f "$path/package.json" ]; then
            info "检测到 DSH 源码: $path"
            (cd "$path" && pnpm dsh plugin --profile "$PROFILE" add "$TGZ_PATH") && installed=true
            break
        fi
    done
fi

if [ "$installed" = false ] && command -v npx &>/dev/null; then
    info "使用 npx @deepseek-ai/dsh（首次需下载）"
    npx @deepseek-ai/dsh plugin --profile "$PROFILE" add "$TGZ_PATH" && installed=true
fi

if [ "$installed" = false ]; then
    err "安装失败。请确保已安装 DSH：npm install -g @deepseek-ai/dsh"
    exit 1
fi
ok "安装完成"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${CYAN}启动 DSH：${NC}"
echo "  dsh $PROFILE"
echo ""
echo "浏览器自动打开 http://127.0.0.1:3080"
echo "左侧边栏底部出现「🖥️ 终端」按钮"
echo ""
echo -e "${CYAN}更新插件：${NC}"
echo "  cd $PLUGIN_DIR && git pull && pnpm install && pnpm build"
echo "  然后重新运行此脚本"
echo ""
