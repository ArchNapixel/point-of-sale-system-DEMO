import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { verifyPayment } from '../db/orders'
import { can } from '../lib/roles'
import { PAY_METHODS } from '../lib/payments'
import { formatPeso } from '../lib/money'
import { matchesOrder } from '../lib/invoice'
import { Err, useAction } from '../ui'
import Receipt from './Receipt'
import RefundPanel from './RefundPanel'

// ponytail: search scans every order in this browser's database in memory (fine for a café's volume; add an index if it gets slow).
// Shows the last 50 matches. Voids/refunds come later (2x).
export default function Orders() {
  const { user } = useAuth()
  const { error, run } = useAction()
  const [q, setQ] = useState('')
  const [viewing, setViewing] = useState('')
  const [acting, setActing] = useState<{ id: string; mode: 'void' | 'refund' } | null>(null)
  const orders = useLiveQuery(async () => {
    const list = (await db.orders.orderBy('paidAt').reverse().toArray()).filter((o) => matchesOrder(o, q)).slice(0, 50)
    const pays = await db.payments.where('orderId').anyOf(list.map((o) => o.id)).toArray()
    const refunds = await db.refunds.where('orderId').anyOf(list.map((o) => o.id)).toArray()
    return list.map((o) => ({ ...o, payments: pays.filter((p) => p.orderId === o.id), refunded: refunds.filter((r) => r.orderId === o.id).reduce((s, r) => s + r.amount, 0) }))
  }, [q])
  const log = useLiveQuery(() => db.discountLog.orderBy('at').reverse().limit(50).toArray(), [])
  const approvals = useLiveQuery(async () => {
    const rows = await db.approvals.orderBy('at').reverse().limit(50).toArray()
    const names = new Map((await db.users.toArray()).map((u) => [u.id, u.name]))
    const terminals = new Map((await db.terminals.toArray()).map((t) => [t.id, t.name]))
    return rows.map((a) => ({ ...a, requester: names.get(a.requesterId) ?? '?', approver: names.get(a.approverId) ?? '?', terminal: terminals.get(a.terminalId) ?? '?' }))
  }, [])
  if (!orders || !user || !log || !approvals) return null
  const label = (m: string) => PAY_METHODS.find((x) => x.id === m)?.label ?? m
  return (
    <section>
      <h2>Orders</h2>
      <input aria-label="Search sales" placeholder="Search invoice no., order #, name, table, date" value={q} onChange={(e) => setQ(e.target.value)} />
      <Err msg={error} />
      {viewing && <Receipt orderId={viewing} onClose={() => setViewing('')} />}
      {orders.length === 0 && <p className="empty">{q ? 'No sales match.' : 'No paid orders yet.'}</p>}
      <ul className="lines">
        {orders.map((o) => (
          <li key={o.id}>
            <div className="row between">
              <span>
                <strong>#{o.number}</strong> <small>{o.invoiceNo}</small> {o.status === 'void' && <strong>VOID </strong>}{o.refunded > 0 && o.status !== 'void' && <strong>REFUNDED {formatPeso(o.refunded)} </strong>}{o.comps && <strong>COMP </strong>}{o.name || (o.table && `Table ${o.table}`) || o.orderType}{' '}
                <small>{o.lines.reduce((s, l) => s + l.qty, 0)} items · {new Date(o.paidAt).toLocaleTimeString('en-PH', { timeStyle: 'short' })} · {o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}</small>
              </span>
              <span className="row"><strong>{formatPeso(o.total)}</strong><button onClick={() => setViewing(o.id)}>Invoice</button>
                {o.status === 'paid' && can(user.role, 'sell') && (
                  <>
                    <button onClick={() => setActing({ id: o.id, mode: 'void' })}>Void</button>
                    <button onClick={() => setActing({ id: o.id, mode: 'refund' })}>Refund</button>
                  </>
                )}
              </span>
            </div>
            {acting?.id === o.id && <RefundPanel key={acting.mode} orderId={o.id} mode={acting.mode} userId={user.id} onDone={() => setActing(null)} />}
            {o.payments.map((p) => (
              <div key={p.id} className="row between">
                <small>
                  {label(p.method)} {formatPeso(p.amount)} {p.reference && `· ref ${p.reference}`} {p.approvalCode && `· ${p.approvalCode} ····${p.last4}`}
                  {p.status === 'pending' && ' · PENDING VERIFICATION'}
                </small>
                {p.status === 'pending' && can(user.role, 'verifyPayment') && (
                  <button onClick={() => run(() => verifyPayment(p.id, user.id))}>Verify</button>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>
      {can(user.role, 'viewDiscountLog') && (
        <>
          <h3>Senior/PWD discount log</h3>
          {log.length === 0 && <p className="empty">No Senior/PWD discounts given.</p>}
          <ul className="lines">
            {log.map((r) => (
              <li key={r.id} className="row between">
                <span>
                  {r.businessDate} · {r.kind === 'senior' ? 'Senior' : 'PWD'} {r.name} · ID {r.idNumber} {r.repeatId && <strong>· REPEAT ID TODAY</strong>}{' '}
                  <small>{r.items} · VAT-exempt {formatPeso(r.vatExempt)} · 20% {formatPeso(r.discountAmount)}</small>
                </span>
                <strong>−{formatPeso(r.reduction)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {can(user.role, 'approve') && (
        <>
          <h3>Approvals</h3>
          {approvals.length === 0 && <p className="empty">No approvals yet.</p>}
          <ul className="lines">
            {approvals.map((a) => (
              <li key={a.id} className="row between">
                <span>
                  {new Date(a.at).toLocaleString('en-PH')} · {a.action} · asked by {a.requester}, approved by {a.approver} · {a.terminal}
                  {a.selfApproved && <strong> · SELF-APPROVED</strong>}
                </span>
                {a.amount > 0 && <strong>{formatPeso(a.amount)}</strong>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
