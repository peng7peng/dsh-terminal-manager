/**
 * F10 汇总条 —— 编辑器底部常驻（§11.3），逐项 ✓ / ✗ / waitReason；执行中可中止；手动关闭。
 * @module dsh-terminal-manager/client/tc/TcSummaryBar
 */

import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { summarize } from './runScript.ts'
import { setTcRun, useTcRun } from './tcRunStore.ts'

const ICON: Record<string, string> = { ok: '✓', timeout: '✗', error: '✗', 'no-target': '✗', running: '⏳', pending: '·', aborted: '–' }
const WHY: Record<string, string> = { timeout: '超时', 'no-target': '无对应在线终端', aborted: '已中止', running: '执行中', pending: '等待' }

export function TcSummaryBar(): React.JSX.Element | null {
  const run = useTcRun()
  if (run === null) return null
  const s = summarize(run.items)
  const bad = s.timeout + s.error + s.noTarget
  return (
    <div className="tm-tcSum">
      <div className="tm-tcSumHead">
        <span>{run.title}</span>
        <span className="ok">✓ {s.ok}</span>
        {bad > 0 && <span className="bad">✗ {bad}</span>}
        {s.aborted > 0 && <span className="warn">– {s.aborted}</span>}
        {run.running && <span className="warn">执行中…</span>}
        <span className="sp" />
        {run.running && run.abort !== undefined && <button type="button" onClick={run.abort}>中止</button>}
        {!run.running && <button type="button" onClick={() => setTcRun(null)} title="关闭汇总"><IconCloseFill14 /></button>}
      </div>
      <div className="tm-tcSumBody">
        {run.items.map(it => (
          <div key={it.key} className={`tm-tcRow ${it.status}`} title={it.message ?? it.waitReason}>
            <span className="st">{ICON[it.status] ?? '·'}</span>
            <span>{it.tc}{it.label !== undefined ? ` ${it.label}` : ''}:</span>
            <span className="cmd">{it.command}</span>
            <span className="why">{it.status === 'ok' ? (it.waitReason === 'prompt' ? '' : it.waitReason ?? '') : it.status === 'error' ? (it.message ?? '失败') : (WHY[it.status] ?? '')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
