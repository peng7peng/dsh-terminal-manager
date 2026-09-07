import { useMemo, useState } from 'react'
import { portLogRpc } from './rpc.ts'
import { sortMappings, type ClientMapping, type MappingSort } from './store.ts'

interface Props { mappings: ClientMapping[]; refresh: () => Promise<void>; reportError: (error: unknown) => void }

const EMPTY = { protocol: 'tcp' as const, localAddr: '127.0.0.1', localPort: '8080', redirectAddr: '127.0.0.1', redirectPort: '80', autoStart: false }

export function MappingsTab({ mappings, refresh, reportError }: Props): React.JSX.Element {
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState<string>()
  const [sort, setSort] = useState<MappingSort>('localPort')
  const sorted = useMemo(() => sortMappings(mappings, sort), [mappings, sort])

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const payload = { ...form, localPort: Number(form.localPort), redirectPort: Number(form.redirectPort) }
    try {
      if (editingId === undefined) await portLogRpc('mappings.create', payload)
      else await portLogRpc('mappings.update', { id: editingId, patch: payload })
      setEditingId(undefined)
      setForm(EMPTY)
      await refresh()
    } catch (error) { reportError(error) }
  }

  function edit(mapping: ClientMapping): void {
    setEditingId(mapping.id)
    setForm({
      protocol: mapping.protocol, localAddr: mapping.localAddr, localPort: String(mapping.localPort),
      redirectAddr: mapping.redirectAddr, redirectPort: String(mapping.redirectPort), autoStart: mapping.autoStart,
    })
  }

  async function action(method: string, payload: Record<string, unknown>): Promise<void> {
    try { await portLogRpc(method, payload); await refresh() } catch (error) { reportError(error) }
  }

  async function importCsv(file: File | undefined): Promise<void> {
    if (file === undefined) return
    try { await portLogRpc('mappings.importCsv', { csv: await file.text() }); await refresh() } catch (error) { reportError(error) }
  }

  async function exportCsv(): Promise<void> {
    try {
      const { csv } = await portLogRpc<{ csv: string }>('mappings.exportCsv')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'port-mappings.csv'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) { reportError(error) }
  }

  return <section className="tm-ext-pl-section">
    <form className="tm-ext-pl-form" onSubmit={(event) => void submit(event)}>
      <select aria-label="协议" value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as 'tcp' | 'udp' })}><option value="tcp">TCP</option><option value="udp">UDP</option></select>
      <input aria-label="监听地址" value={form.localAddr} onChange={(event) => setForm({ ...form, localAddr: event.target.value })} placeholder="监听地址" required />
      <input aria-label="监听端口" type="number" min="1" max="65535" value={form.localPort} onChange={(event) => setForm({ ...form, localPort: event.target.value })} required />
      <span className="tm-ext-pl-arrow">→</span>
      <input aria-label="目标地址" value={form.redirectAddr} onChange={(event) => setForm({ ...form, redirectAddr: event.target.value })} placeholder="目标地址" required />
      <input aria-label="目标端口" type="number" min="1" max="65535" value={form.redirectPort} onChange={(event) => setForm({ ...form, redirectPort: event.target.value })} required />
      <label className="tm-ext-pl-check"><input type="checkbox" checked={form.autoStart} onChange={(event) => setForm({ ...form, autoStart: event.target.checked })} />随插件启动</label>
      <button className="tm-ext-pl-primary" type="submit">{editingId === undefined ? '创建映射' : '保存修改'}</button>
      {editingId !== undefined && <button type="button" onClick={() => { setEditingId(undefined); setForm(EMPTY) }}>取消</button>}
    </form>
    <div className="tm-ext-pl-toolbar">
      <label>排序 <select value={sort} onChange={(event) => setSort(event.target.value as MappingSort)}><option value="localPort">监听端口</option><option value="protocol">协议</option><option value="state">状态</option><option value="bytes">流量</option></select></label>
      <label className="tm-ext-pl-file">导入 CSV<input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event.target.files?.[0])} /></label>
      <button type="button" onClick={() => void exportCsv()}>导出 CSV</button>
    </div>
    <div className="tm-ext-pl-list">
      {sorted.length === 0 && <p className="tm-ext-pl-empty">暂无端口映射</p>}
      {sorted.map((mapping) => <article className="tm-ext-pl-card" key={mapping.id}>
        <div className="tm-ext-pl-card-main"><strong>{mapping.protocol.toUpperCase()} · {mapping.localAddr}:{mapping.localPort}</strong><span>→ {mapping.redirectAddr}:{mapping.redirectPort}</span></div>
        <span className={`tm-ext-pl-status is-${mapping.state}`}>{mapping.state}</span>
        <div className="tm-ext-pl-metrics">活动 {mapping.activeCount} · ↑ {mapping.bytesClientToTarget} B · ↓ {mapping.bytesTargetToClient} B</div>
        {mapping.lastError && <div className="tm-ext-pl-error">最近错误：{mapping.lastError}</div>}
        <div className="tm-ext-pl-actions">
          <button type="button" onClick={() => void action(mapping.state === 'running' ? 'mappings.stop' : 'mappings.start', { id: mapping.id })}>{mapping.state === 'running' ? '停止' : '启动'}</button>
          <button type="button" onClick={() => edit(mapping)}>编辑</button>
          <button type="button" className="danger" onClick={() => void action('mappings.remove', { id: mapping.id })}>删除</button>
        </div>
      </article>)}
    </div>
  </section>
}
