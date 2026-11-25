import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { formatPeso } from '../lib/money'

// ponytail: last 50 paid orders across this browser's database. Filter by day/terminal and add voids/refunds later (1H+).
export default function Orders() {
  const orders = useLiveQuery(() => db.orders.orderBy('paidAt').reverse().limit(50).toArray(), [])
  if (!orders) return null
  return (
    <section>
      <h2>Orders</h2>
      {orders.length === 0 && <p className="empty">No paid orders yet.</p>}
      <ul className="lines">
        {orders.map((o) => (
          <li key={o.id} className="row between">
            <span>
              <strong>#{o.number}</strong> {o.name || (o.table && `Table ${o.table}`) || o.orderType}{' '}
              <small>{o.lines.reduce((s, l) => s + l.qty, 0)} items · {new Date(o.paidAt).toLocaleTimeString('en-PH', { timeStyle: 'short' })} · {o.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}</small>
            </span>
            <strong>{formatPeso(o.total)}</strong>
          </li>
        ))}
      </ul>
    </section>
  )
}
