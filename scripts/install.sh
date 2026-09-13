#!/usr/bin/env bash
# DSH Terminal Manager 安装脚本 (Linux / macOS)
#
# 用法:
#   ./install.sh                          # npm 安装（推荐，普通用户）
#   ./install.sh --profile tm-dev         # 装到指定 profile
#   ./install.sh --from-source            # 源码安装：clone + 构建 + link（开发者）
#   ./install.sh --from-source --dir ~/code/dsh-terminal-manager
#
# 说明：npm 安装走 `dsh plugin --profile <p> add dsh-terminal-manager@latest`，
# 脚本只负责找一个可用的 dsh 入口（全局 dsh / DSH 源码 checkout / npx 兜底）。

set -u

PROFILE="web"
FROM_SOURCE=0
SOURCE_DIR="${HOME}/dsh-terminal-manager"
REPO_URL="https://gitcode.com/pengpengR/dsh-terminal-manager.git"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)     PROFILE="${2:-}"; shift 2 ;;
    --from-source) FROM_SOURCE=1; shift ;;
    --dir)         SOURCE_DIR="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 1 ;;
  esac
done

info() { printf '\033[36m[INFO]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# 找一个能用的 dsh 入口执行 `plugin add`。
run_dsh_plugin() {
  if have dsh; then
    info "使用全局 dsh 命令"
    dsh plugin --profile "$PROFILE" add "$1"
    return $?
  fi

  # DSH 源码 checkout：在它目录下用 `pnpm dsh` 启动
  local script_dir root
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  for root in \
    "${script_dir}/../../deepseek-harness" \
    "$(pwd)/../deepseek-harness" \
    "${HOME}/deepseek-harness"; do
    if [ -f "${root}/package.json" ] && have pnpm; then
      info "检测到 DSH 源码：${root}"
      ( cd "$root" && pnpm dsh plugin --profile "$PROFILE" add "$1" )
      return $?
    fi
  done

  if have npx; then
    info "退回 npx（首次需下载）"
    npx -y --package '@deepseek-ai/dsh' dsh plugin --profile "$PROFILE" add "$1"
    return $?
  fi
  return 1
}

# ---------- 0. 环境检查 ----------
info "检查 Node.js..."
if ! have node; then err "未找到 node，请先安装 Node.js 22+：https://nodejs.org/"; exit 1; fi
node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "${node_major:-0}" -lt 22 ]; then warn "Node.js 版本偏低（$(node --version)），建议 22+"; fi
ok "Node.js $(node --version)"

if ! have pnpm; then
  info "安装 pnpm..."
  npm install -g pnpm || { err "pnpm 安装失败，请手动执行 npm install -g pnpm"; exit 1; }
fi
ok "pnpm $(pnpm --version)"

# ---------- 1. 决定安装目标 ----------
if [ "$FROM_SOURCE" -eq 1 ]; then
  info "源码安装模式，目标目录：${SOURCE_DIR}"
  if [ -d "${SOURCE_DIR}/.git" ]; then
    info "仓库已存在，拉取更新..."
    git -C "${SOURCE_DIR}" pull --ff-only || warn "git pull 失败，继续用现有代码"
  else
    git clone "$REPO_URL" "$SOURCE_DIR" || { err "git clone 失败：$REPO_URL"; exit 1; }
  fi

  ( cd "$SOURCE_DIR" && pnpm install ) || { err "pnpm install 失败"; exit 1; }
  ( cd "$SOURCE_DIR" && pnpm build )   || { err "pnpm build 失败"; exit 1; }

  TARGET="dsh-terminal-manager@link:${SOURCE_DIR}"
else
  TARGET="dsh-terminal-manager@latest"
fi

# ---------- 2. 装进 profile ----------
info "安装 ${TARGET} 到 profile「${PROFILE}」..."
if ! run_dsh_plugin "$TARGET"; then
  err "安装失败。排查建议："
  echo "  1) 确认 DSH 已安装：npm install -g @deepseek-ai/dsh"
  echo "  2) 确认 profile 存在：先跑一次 dsh web --profile ${PROFILE}"
  echo "  3) ssh2 构建脚本被拦：在 ~/.dsh/profiles/${PROFILE} 下跑 pnpm approve-builds --all 后重试"
  exit 1
fi

ok "安装完成"
echo
echo "下一步："
echo "  1) 启动 DSH：dsh web"
echo "  2) 浏览器硬刷新（Ctrl/Cmd + Shift + R），左侧边栏底部出现「🖥️ 终端」按钮"
echo
if [ "$FROM_SOURCE" -eq 1 ]; then
  echo "源码模式：改完代码后重建即可生效："
  echo "  cd ${SOURCE_DIR} && pnpm build"
fi
