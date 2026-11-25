import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Ingredient } from '../db/db'
import {
  closePoShort, createPurchaseOrder, createSupplier, payables, payReceipt, poProgress, receiveDelivery, reviewReceipt, setSupplierActive, suggestedOrder,
  type ReceiveLine,
} from '../db/purchasing'
import { newId } from '../lib/id'
import { formatPeso, parsePesos } from '../lib/money'
import { formatQty, fromBase } from '../lib/units'
import { ymdLocal } from '../lib/promos'
import { Err, useAction } from '../ui'
import { useBranch } from './Stock'

type Part = 'suppliers' | 'orders' | 'receive' | 'payables'
type Draft = { ingredientId: string; qty: string; unit: string; rejected: string; reason: string; cost: string }
const blank = (): Draft => ({ ingredientId: '', qty: '', unit: '', rejected: '', reason: '', cost: '' })

/** Suppliers, purchase orders, receiving deliveries and paying for them. What was ordered, what arrived and what was paid stay three numbers. */
export default function Purchasing() {
  const [part, setPart] = useState<Part>('orders')
  const [receiving, setReceiving] = useState<{ poId?: string; supplierId: string; lines: Draft[] } | null>(null)
  return (
    <section>
      <h2>Purchasing</h2>
      <div className="seg">
        {(['suppliers', 'orders', 'receive', 'payables'] as Part[]).map((p) => (
          <button key={p} aria-pressed={part === p} onClick={() => { setPart(p); if (p !== 'receive') setReceiving(null) }}>{p === 'payables' ? 'Pay suppliers' : p[0].toUpperCase() + p.slice(1)}</button>
        ))}
      </div>
      {part === 'suppliers' && <Suppliers />}
      {part === 'orders' && <Orders onReceive={(r) => { setReceiving(r); setPart('receive') }} />}
      {part === 'receive' && <Receive key={receiving?.poId ?? 'none'} start={receiving} />}
      {part === 'payables' && <Payables />}
    </section>
  )
}

function useIngredients() {
  return useLiveQuery(() => db.ingredients.filter((i) => i.active).toArray().then((l) => l.sort((a, b) => a.name.localeCompare(b.name))), [])
}
const unitsOf = (i?: Ingredient) => (i ? [i.baseUnit as string, ...i.units.filter((u) => u.active).map((u) => u.name)] : [])

function Suppliers() {
  const { user } = useAuth()
  const list = useLiveQuery(() => db.suppliers.toArray().then((l) => l.sort((a, b) => a.name.localeCompare(b.name))), [])
  const [name, setName] = useState('')
  const [terms, setTerms] = useState('0')
  const { error, run } = useAction()
  if (!list || !user) return null
  return (
    <>
      <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createSupplier(name, Number(terms), user.id))) setName('') }}>
        <input aria-label="Supplier name" placeholder="Supplier" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Pay within <input aria-label="Terms in days" size={4} inputMode="numeric" value={terms} onChange={(e) => setTerms(e.target.value)} /> days (0 = on delivery)</label>
        <button className="primary" disabled={!name.trim()}>Add supplier</button>
      </form>
      <Err msg={error} />
      {list.length === 0 && <p className="empty">No suppliers yet.</p>}
      <ul className="lines">
        {list.map((s) => (
          <li key={s.id} className={`row between ${s.active ? '' : 'archived'}`}>
            <span>{s.name} <small>{s.termsDays === 0 ? 'pay on delivery' : `${s.termsDays} days`}</small></span>
            <button onClick={() => run(() => setSupplierActive(s.id, !s.active, user.id))}>{s.active ? 'Archive' : 'Restore'}</button>
          </li>
        ))}
      </ul>
    </>
  )
}

function Orders({ onReceive }: { onReceive: (r: { poId: string; supplierId: string; lines: Draft[] }) => void }) {
  const { user } = useAuth()
  const { branchId, select } = useBranch()
  const ingredients = useIngredients()
  const data = useLiveQuery(async () => {
    const suppliers = await db.suppliers.toArray()
    const pos = (await db.purchaseOrders.toArray()).sort((a, b) => b.at.localeCompare(a.at))
    return { suppliers, pos: await Promise.all(pos.map(async (p) => ({ ...p, progress: await poProgress(p.id) }))) }
  }, [])
  const [supplierId, setSupplierId] = useState('')
  const [rows, setRows] = useState<Draft[]>([blank()])
  const [closing, setClosing] = useState<{ id: string; note: string } | null>(null)
  const { error, run } = useAction()
  if (!data || !ingredients || !user) return null
  const name = (id: string) => ingredients.find((i) => i.id === id)?.name ?? '?'
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const sup = supplierId || data.suppliers.find((s) => s.active)?.id || ''

  return (
    <>
      <div className="card">
        <h3>New purchase order</h3>
        {select}
        <select aria-label="Supplier" value={sup} onChange={(e) => setSupplierId(e.target.value)}>
          {data.suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {rows.map((r, i) => {
          const ing = ingredients.find((x) => x.id === r.ingredientId)
          return (
            <div key={i} className="row">
              <select aria-label="Ingredient" value={r.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value, unit: '' })}>
                <option value="">Ingredient</option>{ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <input aria-label="Quantity" size={6} inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
              <select aria-label="Unit" value={r.unit || ing?.baseUnit || ''} onChange={(e) => set(i, { unit: e.target.value })}>{ing ? unitsOf(ing).map((u) => <option key={u}>{u}</option>) : <option value="">unit</option>}</select>
              <button aria-label="Remove row" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()])}>✕</button>
            </div>
          )
        })}
        <div className="row">
          <button onClick={() => setRows([...rows, blank()])}>Add row</button>
          <button onClick={() => run(async () => {
            const s = await suggestedOrder(branchId)
            if (s.length === 0) throw new Error('Nothing is below its par level. Set par levels on the Ingredients screen.')
            setRows(s.map((x) => ({ ...blank(), ingredientId: x.ingredientId, qty: String(x.qty), unit: ingredients.find((i) => i.id === x.ingredientId)!.baseUnit })))
          })}>Suggest from par</button>
          <button className="primary" onClick={() => run(async () => {
            await createPurchaseOrder({ supplierId: sup, branchId, userId: user.id, lines: rows.map((r) => ({ ingredientId: r.ingredientId, qty: Number(r.qty), unit: r.unit || ingredients.find((i) => i.id === r.ingredientId)?.baseUnit || '' })) })
            setRows([blank()])
          })}>Create order</button>
        </div>
        <Err msg={error} />
      </div>
      {data.pos.length === 0 && <p className="empty">No purchase orders yet.</p>}
      {data.pos.map((p) => (
        <div key={p.id} className="card">
          <div className="row between">
            <strong>{p.number} <small>{data.suppliers.find((s) => s.id === p.supplierId)?.name} · {p.status}{p.closedShort && ' (closed short)'}</small></strong>
            {p.status === 'open' && (
              <span className="row">
                <button onClick={() => onReceive({
                  poId: p.id, supplierId: p.supplierId,
                  lines: p.progress.filter((l) => l.outstanding > 0).map((l) => { const ing = ingredients.find((i) => i.id === l.ingredientId); return { ...blank(), ingredientId: l.ingredientId, qty: String(ing ? fromBase(ing, l.outstanding, ing.baseUnit) : l.outstanding), unit: ing?.baseUnit ?? '' } }),
                })}>Receive</button>
                <button onClick={() => setClosing({ id: p.id, note: '' })}>Close short</button>
              </span>
            )}
          </div>
          <ul className="lines">
            {p.progress.map((l) => {
              const ing = ingredients.find((i) => i.id === l.ingredientId)
              const f = (q: number) => (ing ? formatQty(ing, q) : String(q))
              return <li key={l.ingredientId}>{name(l.ingredientId)}: ordered {f(l.ordered)} · arrived {f(l.received)}{l.rejected > 0 && ` · rejected ${f(l.rejected)}`}{l.outstanding > 0 && ` · still to come ${f(l.outstanding)}`}</li>
            })}
          </ul>
          {closing?.id === p.id && (
            <div className="row">
              <input aria-label="Reason for closing short" placeholder="Why close it short?" value={closing.note} onChange={(e) => setClosing({ id: p.id, note: e.target.value })} />
              <button onClick={() => run(() => closePoShort(p.id, user.id, closing.note)).then((ok) => ok && setClosing(null))}>Close it</button>
              <button onClick={() => setClosing(null)}>Cancel</button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function Receive({ start }: { start: { poId?: string; supplierId: string; lines: Draft[] } | null }) {
  const { user } = useAuth()
  const { branchId, select } = useBranch()
  const ingredients = useIngredients()
  const suppliers = useLiveQuery(() => db.suppliers.filter((s) => s.active).toArray(), [])
  const [supplierId, setSupplierId] = useState(start?.supplierId ?? '')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [arrived, setArrived] = useState('')
  const [rows, setRows] = useState<Draft[]>(start?.lines.length ? start.lines : [blank()])
  const [key, setKey] = useState(newId)
  const { error, run } = useAction()
  if (!ingredients || !suppliers || !user) return null
  const sup = supplierId || suppliers[0]?.id || ''
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const submit = () =>
    run(async () => {
      const lines: ReceiveLine[] = rows.map((r) => {
        const ing = ingredients.find((x) => x.id === r.ingredientId)
        const cost = r.cost.trim() === '' ? 0 : parsePesos(r.cost)
        if (cost === null) throw new Error('Enter the invoice amount in pesos, like 1200 or 1200.50')
        return { ingredientId: r.ingredientId, qty: Number(r.qty || 0), unit: r.unit || ing?.baseUnit || '', rejectedQty: r.rejected ? Number(r.rejected) : 0, rejectReason: r.reason, cost }
      })
      await receiveDelivery({ supplierId: sup, branchId, poId: start?.poId, invoiceNo, arrivedAt: arrived ? new Date(arrived).toISOString() : undefined, lines, userId: user.id, idempotencyKey: key })
      setRows([blank()]); setInvoiceNo(''); setArrived(''); setKey(newId())
    })

  return (
    <div className="card">
      <h3>Receive a delivery {start?.poId ? '(against a purchase order)' : '(no purchase order: a supervisor reviews it)'}</h3>
      {select}
      <div className="row">
        <select aria-label="Supplier" value={sup} onChange={(e) => setSupplierId(e.target.value)} disabled={!!start?.poId}>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input aria-label="Invoice number" placeholder="Invoice no." value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        <label>Arrived <input type="datetime-local" value={arrived} onChange={(e) => setArrived(e.target.value)} /></label>
      </div>
      <small>Enter what you counted, what you turned away, and the invoice amount for what you kept.</small>
      {rows.map((r, i) => {
        const ing = ingredients.find((x) => x.id === r.ingredientId)
        return (
          <div key={i} className="row">
            <select aria-label="Ingredient" value={r.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value, unit: '' })}>
              <option value="">Ingredient</option>{ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <input aria-label="Received" size={6} inputMode="decimal" placeholder="Received" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            <select aria-label="Unit" value={r.unit || ing?.baseUnit || ''} onChange={(e) => set(i, { unit: e.target.value })}>{ing ? unitsOf(ing).map((u) => <option key={u}>{u}</option>) : <option value="">unit</option>}</select>
            <input aria-label="Rejected" size={6} inputMode="decimal" placeholder="Rejected" value={r.rejected} onChange={(e) => set(i, { rejected: e.target.value })} />
            {r.rejected && <input aria-label="Reject reason" placeholder="Why? (damaged, near expiry)" value={r.reason} onChange={(e) => set(i, { reason: e.target.value })} />}
            <input aria-label="Invoice amount" size={9} inputMode="decimal" placeholder="Invoice ₱" value={r.cost} onChange={(e) => set(i, { cost: e.target.value })} />
            <button aria-label="Remove row" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()])}>✕</button>
          </div>
        )
      })}
      <div className="row">
        <button onClick={() => setRows([...rows, blank()])}>Add row</button>
        <button className="primary" onClick={submit}>Receive into stock</button>
      </div>
      <Err msg={error} />
    </div>
  )
}

function Payables() {
  const { user } = useAuth()
  const data = useLiveQuery(async () => ({
    unpaid: await payables(ymdLocal(new Date())),
    review: (await db.receipts.filter((r) => r.needsReview).toArray()),
    suppliers: new Map((await db.suppliers.toArray()).map((s) => [s.id, s.name])),
    names: new Map((await db.users.toArray()).map((u) => [u.id, u.name])),
    outs: (await db.cashMovements.filter((m) => m.kind === 'paid-out').toArray()),
    used: new Set((await db.receipts.toArray()).flatMap((r) => (r.cashMovementId ? [r.cashMovementId] : []))),
  }), [])
  const [ref, setRef] = useState<Record<string, string>>({})
  const { error, run } = useAction()
  if (!data || !user) return null
  return (
    <>
      <Err msg={error} />
      <h3>Deliveries to review (no purchase order)</h3>
      {data.review.length === 0 && <p className="empty">None.</p>}
      <ul className="lines">
        {data.review.map((r) => (
          <li key={r.id} className="row between">
            <span>{data.suppliers.get(r.supplierId)} {r.invoiceNo} · {formatPeso(r.total)} · received by {data.names.get(r.by)}</span>
            <button onClick={() => run(() => reviewReceipt(r.id, user.id))}>Mark reviewed</button>
          </li>
        ))}
      </ul>
      <h3>Unpaid deliveries</h3>
      {data.unpaid.length === 0 && <p className="empty">Nothing owed.</p>}
      {data.unpaid.map((r) => {
        const outs = data.outs.filter((m) => m.amount === r.total && !data.used.has(m.id))
        return (
          <div key={r.id} className={`card ${r.overdue ? 'flag' : ''}`}>
            <div className="row between">
              <span><strong>{data.suppliers.get(r.supplierId)}</strong> {r.invoiceNo} <small>due {r.dueDate}{r.overdue && ' · OVERDUE'}</small></span>
              <strong>{formatPeso(r.total)}</strong>
            </div>
            <div className="row">
              <input aria-label="Transfer reference" placeholder="Bank transfer ref" value={ref[r.id] ?? ''} onChange={(e) => setRef({ ...ref, [r.id]: e.target.value })} />
              <button onClick={() => run(() => payReceipt({ receiptId: r.id, method: 'transfer', reference: ref[r.id], userId: user.id }))}>Paid by transfer</button>
              {outs.map((m) => <button key={m.id} onClick={() => run(() => payReceipt({ receiptId: r.id, method: 'cash', cashMovementId: m.id, userId: user.id }))}>Paid from drawer ({m.reason})</button>)}
              {outs.length === 0 && <small>Cash: record a paid-out for {formatPeso(r.total)} on the Shift tab first.</small>}
            </div>
          </div>
        )
      })}
    </>
  )
}
