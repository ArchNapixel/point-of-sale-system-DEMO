import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { applyCount, countReport, countSheet, submitCount } from '../db/counts'
import { newId } from '../lib/id'
import { can } from '../lib/roles'
import { formatPeso } from '../lib/money'
import { formatQty } from '../lib/units'
import { Err, useAction } from '../ui'
import { useBranch } from './Stock'

/** Blind stock count: type what you see. Expected is hidden until you submit, then the variance report shows the gap in units and pesos. */
export default function Counts() {
  const { user } = useAuth()
  const { branchId, select, ready } = useBranch()
  const sheet = useLiveQuery(countSheet, [])
  const history = useLiveQuery(() => db.stockCounts.orderBy('countedAt').reverse().limit(10).toArray(), [])
  const [qty, setQty] = useState<Record<string, { q: string; unit: string }>>({})
  const [countedAt, setCountedAt] = useState('')
  const [key, setKey] = useState(newId)
  const [shown, setShown] = useState('')
  const { error, run } = useAction()
  if (!sheet || !history || !user || !ready) return null

  const submit = () =>
    run(async () => {
      const entries = sheet.flatMap((s) => {
        const e = qty[s.id]
        return e && e.q.trim() !== '' ? [{ ingredientId: s.id, qty: Number(e.q), unit: e.unit || s.baseUnit }] : []
      })
      const c = await submitCount({ branchId, countedAt: countedAt ? new Date(countedAt).toISOString() : undefined, entries, userId: user.id, idempotencyKey: key })
      setShown(c.id); setQty({}); setCountedAt(''); setKey(newId())
    })

  return (
    <section>
      <h2>Stock count</h2>
      {select}
      {shown && <Report id={shown} canApply={can(user.role, 'editStock')} userId={user.id} onClose={() => setShown('')} />}
      <div className="card">
        <small>Count what is on the shelf. Leave blank what you did not count (0 is a count). You will not see what the system expects.</small>
        <label>Counted at <input type="datetime-local" value={countedAt} onChange={(e) => setCountedAt(e.target.value)} /></label>
        <small> (leave empty for now; a count taken earlier is not distorted by later sales)</small>
        {sheet.map((s) => (
          <div key={s.id} className="row">
            <span style={{ minWidth: '10rem' }}>{s.name}</span>
            <input aria-label={`${s.name} counted`} size={8} inputMode="decimal" value={qty[s.id]?.q ?? ''} onChange={(e) => setQty({ ...qty, [s.id]: { q: e.target.value, unit: qty[s.id]?.unit ?? '' } })} />
            <select aria-label={`${s.name} unit`} value={qty[s.id]?.unit || s.baseUnit} onChange={(e) => setQty({ ...qty, [s.id]: { q: qty[s.id]?.q ?? '', unit: e.target.value } })}>
              {[s.baseUnit as string, ...s.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>)}
            </select>
          </div>
        ))}
        {sheet.length === 0 && <p className="empty">Add ingredients first.</p>}
        <Err msg={error} />
        <button className="primary" onClick={submit} disabled={Object.values(qty).every((e) => !e.q.trim())}>Submit count</button>
      </div>
      <h3>Recent counts</h3>
      {history.length === 0 && <p className="empty">No counts yet.</p>}
      <ul className="lines">
        {history.map((c) => (
          <li key={c.id} className="row between">
            <span>{new Date(c.countedAt).toLocaleString('en-PH')} · {c.lines.length} ingredient(s) · {c.status}</span>
            <button onClick={() => setShown(c.id)}>Variance report</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Report({ id, canApply, userId, onClose }: { id: string; canApply: boolean; userId: string; onClose: () => void }) {
  const r = useLiveQuery(() => countReport(id), [id])
  const { error, run } = useAction()
  if (!r) return null
  return (
    <div className="card">
      <h3>Variance report <small>counted {new Date(r.count.countedAt).toLocaleString('en-PH')} · {r.count.status}</small></h3>
      <table className="compare">
        <thead><tr><th>Ingredient</th><th>Expected</th><th>Counted</th><th>Difference</th><th>₱</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.ingredientId} className={x.variance === 0 ? '' : 'flag'}>
              <th>{x.ingredient.name}</th>
              <td>{formatQty(x.ingredient, x.expected)}</td>
              <td>{formatQty(x.ingredient, x.counted)}</td>
              <td>{x.variance > 0 ? '+' : ''}{formatQty(x.ingredient, x.variance)}</td>
              <td>{x.avgCostMilli === undefined ? 'no cost yet' : formatPeso(x.pesos)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p><strong>Total {r.totalPesos < 0 ? 'missing' : 'extra'}: {formatPeso(Math.abs(r.totalPesos))}</strong></p>
      {r.cups.map((c) => c.missing > 0 && (
        <p key={c.ingredient.id} role="status">
          <strong>{c.missing} {c.ingredient.name}(s) fewer than the sales explain.</strong> That is about {c.missing} drink(s) that went out without a sale: roughly {formatPeso(c.estimatedLost)} at an average {formatPeso(r.avgDrinkPrice)}.
        </p>
      ))}
      <Err msg={error} />
      <div className="row">
        <button onClick={onClose}>Close</button>
        {r.count.status === 'submitted' && canApply && <button className="primary" onClick={() => run(() => applyCount(id, userId))}>Apply to stock</button>}
        {r.count.status === 'submitted' && !canApply && <small>A supervisor applies this to the stock levels.</small>}
      </div>
    </div>
  )
}
