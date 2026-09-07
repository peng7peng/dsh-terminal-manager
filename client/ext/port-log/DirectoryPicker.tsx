import { useCallback, useEffect, useState } from 'react'
import { portLogRpc } from './rpc.ts'

interface DirEntry {
  path: string
  parent: string | null
  dirs: string[]
}

interface Props {
  initialPath: string
  onSelect: (path: string) => void
  onCancel: () => void
}

export function DirectoryPicker({ initialPath, onSelect, onCancel }: Props): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [dirs, setDirs] = useState<string[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await portLogRpc<DirEntry>('sessionLogs.listDir', { path })
      setCurrentPath(result.path)
      setDirs(result.dirs)
      setParent(result.parent)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取目录')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(currentPath) }, [load])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={onCancel}>
      <div style={{ width: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.2)', color: 'var(--dsw-alias-label-primary, #000)', font: '14px/1.5 var(--dsw-font-family, system-ui, sans-serif)' }} onClick={e => e.stopPropagation()}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))' }}>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>选择日志目录</span>
          <button type="button" onClick={onCancel} style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #666)', lineHeight: 1 }}>&times;</button>
        </div>
        <div style={{ flex: 'none', padding: '8px 16px', background: 'var(--dsw-alias-bg-layer-2, #f5f6f7)', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', fontFamily: 'var(--dsw-font-code, monospace)', wordBreak: 'break-all' }}>{currentPath}</div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px' }}>
          {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 13 }}>加载中…</div>}
          {error && <div style={{ padding: 12, color: 'var(--dsw-alias-state-error-primary, #ef4444)', fontSize: 12 }}>{error}</div>}
          {!loading && !error && parent !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 13 }} onClick={() => void load(parent)} onMouseEnter={e => e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, #f5f6f7)'} onMouseLeave={e => e.currentTarget.style.background = ''}>
              <span>📁</span><span>..</span>
            </div>
          )}
          {!loading && !error && dirs.map(name => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }} onClick={() => void load(`${currentPath}/${name}`)} onMouseEnter={e => e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, #f5f6f7)'} onMouseLeave={e => e.currentTarget.style.background = ''}>
              <span>📁</span><span>{name}</span>
            </div>
          ))}
          {!loading && !error && dirs.length === 0 && parent === null && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 13 }}>无子目录</div>
          )}
        </div>
        <div style={{ flex: 'none', display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))' }}>
          <button type="button" className="tm-btn" onClick={onCancel}>取消</button>
          <button type="button" className="tm-btn primary" onClick={() => onSelect(currentPath)}>选择此目录</button>
        </div>
      </div>
    </div>
  )
}
