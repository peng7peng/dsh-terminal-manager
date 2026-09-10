/**
 * 本地文件面板状态同步——浏览器侧面板的 root / cwd 镜像到 host。
 *
 * 面板的 root 和 cwd 是纯前端状态（localFs.ts），host 侧工具层默认不知道。
 * 前端每次目录切换后经 RPC `files.setLocalPanel` 把 { root, cwd } 推到 host，
 * 工具层用这个状态做 tm_download 默认目录 + tm_upload/tm_download 围栏基准。
 *
 * 初始值为空——面板尚未同步时回退到 workspaceRoot（config.ts）。
 * @module dsh-terminal-manager/local-panel-state
 */

/** 面板状态持有者：可变单例，remotes 和 tools 共享同一个引用。 */
export interface LocalPanelState {
  /** 面板当前树根（用户可「换目录」；空 = 尚未同步，回退 workspaceRoot） */
  root: string
  /** 面板当前目录（空 = 尚未同步，回退 workspaceRoot） */
  cwd: string
}

export function createLocalPanelState(): LocalPanelState {
  return { root: '', cwd: '' }
}

/** 取有效树根：面板已同步用面板 root，否则回退 workspaceRoot。 */
export function effectiveRoot(state: LocalPanelState, fallback: string): string {
  return state.root.length > 0 ? state.root : fallback
}

/** 取有效目录：面板已同步用面板 cwd，否则回退 workspaceRoot。 */
export function effectiveCwd(state: LocalPanelState, fallback: string): string {
  return state.cwd.length > 0 ? state.cwd : fallback
}
