/**
 * 「浏览」标准目录选择器 —— Windows「打开文件夹」式的本地目录选择：
 * - 左侧：快速访问（桌面 / 下载 / 文档 / 图片 / 音乐 / 视频）+ 此电脑（盘符列表）；
 * - 顶部：后退 / 前进 / 上一级，以及可点击的面包屑地址栏（点击地址栏切换为路径输入，回车跳转）；
 * - 主区：逐步进入子目录；「此电脑」视图展示全部盘符；
 * - 底部：「选择此目录」提交当前所在目录，「取消」关闭。
 * @module dsh-terminal-manager/client/ext/port-log/DirectoryPicker
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconChevronUpOutline14, IconCloseOutline16, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { portLogRpc } from './rpc.ts'

interface DirEntry {
  path: string
  parent: string | null
  dirs: string[]
}

interface QuickFolder { id: string; label: string; path: string }
interface DriveEntry { label: string; path: string }
interface KnownFolders { home: string; quick: QuickFolder[]; drives: DriveEntry[] }

interface Props {
  initialPath: string
  onSelect: (path: string) => void
  onCancel: () => void
}

/** 「此电脑」虚拟视图（无真实路径），用空串作为哨兵 */
const THIS_PC = ''

/** 快速访问项的图标（沿用本应用文件面板的 emoji 风格） */
const QUICK_ICONS: Record<string, string> = {
  desktop: '🖥️', downloads: '📥', documents: '📄', pictures: '🖼️', music: '🎵', videos: '🎬',
}

/** 拼子目录绝对路径（兼容 Windows 盘符与 POSIX 根） */
function joinPath(base: string, name: string): string {
  if (base.endsWith('/') || base.endsWith('\\')) return `${base}${name}`
  return /^[A-Za-z]:/.test(base) ? `${base}\\${name}` : `${base}/${name}`
}

interface Crumb { label: string; path: string }

/** 路径比较键：统一分隔符为 /、去尾斜杠、盘符小写，让 `C:\a` 与 `C:/a/` 视为同一目录 */
function pathKey(value: string): string {
  return value.replace(/^([A-Za-z]):/, (_, letter: string) => `${letter.toLowerCase()}:`).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function samePathKey(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}

/** 把当前路径拆成可点击的面包屑；Windows 在盘符前补一个「此电脑」入口 */
function splitPath(path: string): Crumb[] {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const drive = `${path[0].toUpperCase()}:/`
    const rest = path.slice(2).replace(/[\\/]+/g, '/').replace(/^\/|\/$/g, '')
    const crumbs: Crumb[] = [{ label: '此电脑', path: THIS_PC }, { label: drive, path: drive }]
    let acc = drive
    for (const seg of rest.split('/').filter(Boolean)) {
      acc = `${acc}${seg}/`
      crumbs.push({ label: seg, path: acc })
    }
    return crumbs
  }
  const crumbs: Crumb[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const seg of path.split('/').filter(Boolean)) {
    acc = `${acc}/${seg}`
    crumbs.push({ label: seg, path: acc })
  }
  return crumbs
}

export function DirectoryPicker({ initialPath, onSelect, onCancel }: Props): React.JSX.Element {
  const [current, setCurrent] = useState<string>(initialPath)
  const [dirs, setDirs] = useState<string[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [quick, setQuick] = useState<QuickFolder[]>([])
  const [drives, setDrives] = useState<DriveEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [forward, setForward] = useState<string[]>([])
  const [editMode, setEditMode] = useState(false)
  const [editVal, setEditVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  // 侧边栏本机概览（桌面 / 下载 / … / 盘符）；失败不影响目录浏览
  useEffect(() => {
    portLogRpc<KnownFolders>('sessionLogs.knownFolders', {}).then(
      (kf) => { setQuick(kf.quick); setDrives(kf.drives) },
      () => { /* 略过：无快捷入口也能用 */ },
    )
  }, [])

  /** 加载一个真实目录；THIS_PC 是纯前端虚拟视图 */
  const go = useCallback(async (path: string): Promise<void> => {
    if (path === THIS_PC) {
      setCurrent(THIS_PC)
      setDirs([])
      setParent(null)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await portLogRpc<DirEntry>('sessionLogs.listDir', { path })
      setCurrent(result.path)
      setDirs(result.dirs)
      setParent(result.parent)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取目录')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void go(initialPath) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** 进入某目录（记录历史、清空前进栈）；同目录（路径写法不同）只刷新展示不记历史 */
  const navigate = useCallback((path: string): void => {
    if (samePathKey(path, current)) {
      if (pathKey(path) !== pathKey(current)) setCurrent(path)
      return
    }
    setHistory(h => [...h, current])
    setForward([])
    void go(path)
  }, [current, go])

  const up = useCallback((): void => {
    if (current === THIS_PC) return
    if (parent === null) navigate(THIS_PC) // 盘符根 / 系统根之上是「此电脑」
    else navigate(parent)
  }, [current, parent, navigate])

  const back = useCallback((): void => {
    if (history.length === 0) return
    const target = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    setForward(f => [...f, current])
    void go(target)
  }, [history, current, go])

  const forwardGo = useCallback((): void => {
    if (forward.length === 0) return
    const target = forward[forward.length - 1]
    setForward(f => f.slice(0, -1))
    setHistory(h => [...h, current])
    void go(target)
  }, [forward, current, go])

  const startEdit = (): void => {
    doneRef.current = false
    setEditVal(current === THIS_PC ? '' : current)
    setEditMode(true)
  }

  const submitEdit = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    const value = editVal.trim()
    setEditMode(false)
    if (value !== '' && value !== current) navigate(value)
  }

  useEffect(() => { if (editMode) inputRef.current?.focus() }, [editMode])

  const crumbs = useMemo<Crumb[]>(() => (current === THIS_PC ? [{ label: '此电脑', path: THIS_PC }] : splitPath(current)), [current])

  const isActive = (path: string): boolean => samePathKey(path, current)

  const driveActive = (drive: DriveEntry): boolean => {
    if (current === THIS_PC) return false
    if (/^[A-Za-z]:/.test(current)) return current[0].toUpperCase() === drive.label[0].toUpperCase()
    return drive.label === '/'
  }

  return (
    <div className="tm-mask" onClick={onCancel} onKeyDown={e => { if (e.key === 'Escape') onCancel() }}>
      <div className="tm-modal tm-dp" onClick={e => e.stopPropagation()}>
        <div className="tm-mHead">
          <IconFolderOpen16 /> 选择日志目录
          <span style={{ flex: 1 }} />
          <button type="button" className="tm-dp-nav" onClick={onCancel} title="关闭" aria-label="关闭"><IconCloseOutline16 /></button>
        </div>
        <div className="tm-dp-body">
          <aside className="tm-dp-side">
            {quick.length > 0 && <>
              <div className="tm-dp-sideLabel">快速访问</div>
              {quick.map(folder => (
                <div key={folder.id} className={'tm-dp-item' + (isActive(folder.path) ? ' act' : '')} title={folder.path} onClick={() => navigate(folder.path)}>
                  <span style={{ fontSize: 14, lineHeight: 1 }}>{QUICK_ICONS[folder.id] ?? '📁'}</span><span>{folder.label}</span>
                </div>
              ))}
            </>}
            <div className="tm-dp-sideLabel">此电脑</div>
            <div className={'tm-dp-item' + (current === THIS_PC ? ' act' : '')} onClick={() => navigate(THIS_PC)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>💻</span><span>此电脑</span>
            </div>
            {drives.map(drive => (
              <div key={drive.path} className={'tm-dp-item' + (driveActive(drive) ? ' act' : '')} title={drive.path} onClick={() => navigate(drive.path)}>
                <span style={{ fontSize: 14, lineHeight: 1 }}>💿</span><span>{drive.label}</span>
              </div>
            ))}
            {drives.length === 0 && <div className="tm-dp-hint" style={{ textAlign: 'left', padding: '2px 14px' }}>未发现磁盘</div>}
          </aside>
          <section className="tm-dp-main">
            <div className="tm-dp-toolbar">
              <button type="button" className="tm-dp-nav" disabled={history.length === 0} onClick={back} title="后退" aria-label="后退"><IconChevronLeftOutline14 /></button>
              <button type="button" className="tm-dp-nav" disabled={forward.length === 0} onClick={forwardGo} title="前进" aria-label="前进"><IconChevronRightOutline14 /></button>
              <button type="button" className="tm-dp-nav" disabled={current === THIS_PC} onClick={up} title="上一级" aria-label="上一级"><IconChevronUpOutline14 /></button>
              <div className="tm-dp-addr" title="点击输入完整路径后回车" onClick={() => { if (!editMode) startEdit() }}>
                {editMode ? (
                  <input
                    ref={inputRef}
                    value={editVal}
                    spellCheck={false}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={submitEdit}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitEdit()
                      else if (e.key === 'Escape') { e.stopPropagation(); doneRef.current = true; setEditMode(false) }
                    }}
                  />
                ) : (
                  crumbs.map((crumb, index) => (
                    <span key={index} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                      <span className={'tm-dp-crumb' + (samePathKey(crumb.path, current) ? ' act' : '')} title={crumb.path} onClick={e => { e.stopPropagation(); navigate(crumb.path) }}>
                        {crumb.label}
                      </span>
                      {index < crumbs.length - 1 && <span className="tm-dp-crumbSep">›</span>}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div className="tm-dp-list">
              {error !== null && <div className="tm-dp-err">{error}</div>}
              {current === THIS_PC ? (
                drives.length === 0
                  ? <div className="tm-dp-hint">未发现可用磁盘</div>
                  : drives.map(drive => (
                    <div key={drive.path} className="tm-dp-row" title={`${drive.label}（单击进入）`} onClick={() => navigate(drive.path)}>
                      <span className="ico">💿</span><span className="nm">{drive.label}</span>
                    </div>
                  ))
              ) : (
                <>
                  {loading && dirs.length === 0 && <div className="tm-dp-hint">加载中…</div>}
                  {!loading && error === null && dirs.length === 0 && <div className="tm-dp-hint">（空目录）</div>}
                  {!loading && error === null && dirs.map(name => (
                    <div key={name} className="tm-dp-row" title={`${name}（单击进入）`} onClick={() => navigate(joinPath(current, name))}>
                      <span className="ico">📁</span><span className="nm">{name}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>
        </div>
        <div className="tm-mFoot">
          <span className="tm-mNote" style={{ padding: 0 }}>单击目录进入，选好后点「选择此目录」</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="tm-btnPlain" onClick={onCancel}>取消</button>
          <button type="button" className="tm-btnPrimary" disabled={current === THIS_PC} onClick={() => onSelect(current)}>选择此目录</button>
        </div>
      </div>
    </div>
  )
}
