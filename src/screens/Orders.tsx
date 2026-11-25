import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { verifyPayment } from '../db/orders'
import { can } from '../lib/roles'
import { PAY_METHODS } from '../lib/payments'
import { formatPeso } from '../lib/money'
import { Err, useAction } from '../ui'

// ponytail: last 50 paid orders across this browser's database. Filter by day/terminal and add voids/refunds later (1H+).
export default function Orders() {
  const { user } = useAuth()
  const { error, run } = useAction()
  const orders = useLiveQuery(async () => {
    const list = await db.orders.orderBy('paidAt').reverse().limit(50).toArray()
    const pays = await db.payments.where('orderId').anyOf(list.map((o) => o.id)).toArray()
    return list.map((o) => ({ ...o, payments: pays.filter((p) => p.orderId === o.id) }))
  }, [])
  const log = useLiveQuery(() => db.discountLog.orderBy('at').reverse().limit(50).toArray(), [])
  if (!orders || !user || !log) return null
  const label = (m: string) => PAY_METHODS.find((x) => x.id === m)?.label ?? m
  return (
    <section>
      <h2>Orders</h2>
      <Err msg={error} />
      {orders.length === 0 && <p className="empty">No paid orders yet.</p>}
      <ul className="lines">
        {orders.map((o) => (
          <li key={o.id}>
            <div className="row between">
              <span>
                <strong>#{o.number}</strong> {o.name || (o.table && `Table ${o.table}`) || o.orderType}{' '}
                <small>{o.lines.reduce((s, l) => s + l.qty, 0)} items · {new Date(o.paidAt).toLocaleTimeString('en-PH', { timeStyle: 'short' })} · {o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}</small>
              </span>
              <strong>{formatPeso(o.total)}</strong>
            </div>
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
    </section>
  )
}
