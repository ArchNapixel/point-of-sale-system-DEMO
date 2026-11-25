import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { receiveStock, stockLevels } from '../db/stock'
import { formatQty } from '../lib/units'
import { Err, useAction } from '../ui'

/** Branch picker that starts on this device's branch. */
export function useBranch() {
  const branches = useLiveQuery(() => db.branches.filter((b) => b.active).toArray(), [])
  const terminals = useLiveQuery(() => db.terminals.filter((t) => t.active).toArray(), [])
  const [picked, setPicked] = useState('')
  const own = terminals && resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))?.branchId
  const branchId = picked || own || branches?.[0]?.id || ''
  const select = branches && branches.length > 1 ? (
    <label>Branch <select value={branchId} onChange={(e) => setPicked(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  ) : null
  return { branchId, select, ready: !!branches }
}

/** Stock = the sum of the ledger. Negative is shown, not hidden: the count was wrong, fix it at the next count. */
export default function Stock() {
  const { user } = useAuth()
  const { branchId, select, ready } = useBranch()
  const data = useLiveQuery(async () => ({
    ingredients: (await db.ingredients.toArray()).sort((a, b) => a.name.localeCompare(b.name)),
    levels: await stockLevels(branchId),
  }), [branchId])
  const [f, setF] = useState({ ingredientId: '', qty: '', unit: '', note: '' })
  const { error, run } = useAction()
  if (!data || !user || !ready) return null
  const active = data.ingredients.filter((i) => i.active)
  const ing = active.find((i) => i.id === f.ingredientId)
  const negative = data.ingredients.filter((i) => (data.levels.get(i.id) ?? 0) < 0)
  return (
    <section>
      <h2>Stock</h2>
      {select}
      {negative.length > 0 && (
        <p role="status"><strong>Below zero: {negative.map((i) => `${i.name} (${formatQty(i, data.levels.get(i.id) ?? 0)})`).join(', ')}.</strong> Sales were not blocked. Check the count.</p>
      )}
      {data.ingredients.length === 0 && <p className="empty">Add ingredients first.</p>}
      <table className="compare">
        <tbody>
          {data.ingredients.map((i) => {
            const q = data.levels.get(i.id) ?? 0
            return <tr key={i.id} className={q < 0 ? 'flag' : ''}><th>{i.name}{!i.active && ' (archived)'}</th><td>{formatQty(i, q)}</td></tr>
          })}
        </tbody>
      </table>
      <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => receiveStock({ ingredientId: f.ingredientId, branchId, qty: Number(f.qty), unit: f.unit || ing?.baseUnit || '', note: f.note, userId: user.id }))) setF({ ...f, qty: '', note: '' }) }}>
        <strong>Receive stock</strong>
        <select aria-label="Ingredient" value={f.ingredientId} onChange={(e) => setF({ ...f, ingredientId: e.target.value, unit: '' })}>
          <option value="">Ingredient</option>{active.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <input aria-label="Quantity" inputMode="decimal" size={6} placeholder="Qty" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <select aria-label="Unit" value={f.unit || ing?.baseUnit || ''} onChange={(e) => setF({ ...f, unit: e.target.value })}>
          {ing ? [ing.baseUnit as string, ...ing.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>) : <option value="">unit</option>}
        </select>
        <input aria-label="Note" placeholder="Note (delivery, supplier)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button className="primary" disabled={!f.ingredientId || !f.qty}>Receive</button>
      </form>
      <small>Purchase orders, supplier prices and cost come in the next part.</small>
      <Err msg={error} />
    </section>
  )
}
