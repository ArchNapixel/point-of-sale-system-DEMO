import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { recordWaste } from '../db/stock'
import { WASTE_REASONS } from '../lib/stock'
import { formatQty } from '../lib/units'
import { Err, useAction } from '../ui'
import { useBranch } from './Stock'

/** Waste: spoiled milk, a spilled cup, grinder calibration, a staff meal, end-of-day pastries. Every entry needs a reason. */
export default function Waste() {
  const { user } = useAuth()
  const { branchId, select, ready } = useBranch()
  const data = useLiveQuery(async () => {
    const ingredients = (await db.ingredients.filter((i) => i.active).toArray()).sort((a, b) => a.name.localeCompare(b.name))
    const last = await db.stockMoves.orderBy('businessDate').last()
    const recent = last ? (await db.stockMoves.where('businessDate').equals(last.businessDate).toArray()).filter((m) => m.kind === 'waste').sort((x, y) => y.at.localeCompare(x.at)) : []
    return { ingredients, recent, names: new Map((await db.users.toArray()).map((u) => [u.id, u.name])) }
  }, [])
  const [f, setF] = useState({ ingredientId: '', qty: '', unit: '', reason: '', note: '' })
  const { error, run } = useAction()
  if (!data || !user || !ready) return null
  const ing = data.ingredients.find((i) => i.id === f.ingredientId)
  return (
    <section>
      <h2>Waste</h2>
      {select}
      <form
        className="card row"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await run(() => recordWaste({ ingredientId: f.ingredientId, branchId, qty: Number(f.qty), unit: f.unit || ing?.baseUnit || '', reason: f.reason, note: f.note, userId: user.id }))) setF({ ...f, qty: '', note: '' })
        }}
      >
        <select aria-label="Ingredient" value={f.ingredientId} onChange={(e) => setF({ ...f, ingredientId: e.target.value, unit: '' })}>
          <option value="">Ingredient</option>{data.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input aria-label="Quantity" inputMode="decimal" size={6} placeholder="Qty" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <select aria-label="Unit" value={f.unit || ing?.baseUnit || ''} onChange={(e) => setF({ ...f, unit: e.target.value })}>
          {ing ? [ing.baseUnit as string, ...ing.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>) : <option value="">unit</option>}
        </select>
        <select aria-label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
          <option value="">Pick a reason</option>{WASTE_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <input aria-label="Note" placeholder={f.reason === 'other' ? 'What happened? (required)' : 'Note (optional)'} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button className="primary" disabled={!f.ingredientId || !f.qty || !f.reason}>Log waste</button>
      </form>
      <Err msg={error} />
      <h3>Latest day's waste</h3>
      {data.recent.length === 0 && <p className="empty">Nothing logged.</p>}
      <ul className="lines">
        {data.recent.map((m) => {
          const i = data.ingredients.find((x) => x.id === m.ingredientId)
          return <li key={m.id}>{new Date(m.at).toLocaleTimeString('en-PH', { timeStyle: 'short' })} · {i ? `${i.name} ${formatQty(i, -m.qty)}` : '?'} · {WASTE_REASONS.find((r) => r.id === m.reason)?.label ?? m.reason}{m.note && ` · ${m.note}`} <small>{data.names.get(m.userId)}</small></li>
        })}
      </ul>
    </section>
  )
}
