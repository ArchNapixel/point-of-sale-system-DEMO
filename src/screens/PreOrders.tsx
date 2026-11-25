import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type PreOrder } from '../db/db'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { cancelPreOrder, startPrep } from '../db/preorders'
import { getSetting } from '../db/settings'
import { emptyCart, lineTotal } from '../lib/cart'
import { dueSoon, timeline } from '../lib/preorders'
import { formatPeso } from '../lib/money'
import { checkReason } from '../lib/reasons'
import { Err, useAction } from '../ui'
import ApprovalPrompt from './ApprovalPrompt'
import ReasonFields, { NO_REASON } from './ReasonFields'
import { fulfilKey } from './Order'

const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
const hm = (d: Date) => d.toLocaleTimeString('en-PH', { timeStyle: 'short' })

/** Pre-orders on a timeline: bulk orders stand out, with when the bar must start. The bar is reminded ahead of pickup. */
export default function PreOrders({ onGo }: { onGo: () => void }) {
  const { user } = useAuth()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  const data = useLiveQuery(async () => {
    const terminals = (await db.terminals.toArray()).filter((t) => t.active)
    const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
    const all = terminal ? (await db.preOrders.where('branchId').equals(terminal.branchId).toArray()) : []
    return {
      terminal, all,
      deposits: new Map((await db.deposits.toArray()).filter((d) => d.status === 'held').map((d) => [d.preOrderId, d])),
      lead: await getSetting('preOrderLeadMinutes'), perItem: await getSetting('queueMinutesPerItem'), bulk: await getSetting('bulkOrderDrinks'),
    }
  }, [])
  const [cancelling, setCancelling] = useState('')
  const [reason, setReason] = useState(NO_REASON)
  const [asking, setAsking] = useState(false)
  const { error, run } = useAction()
  if (!data || !user) return null
  if (!data.terminal) return <p>This device is not set up as a store terminal yet.</p>
  const terminal = data.terminal
  const rows = timeline(data.all, data.bulk, data.perItem)
  const reminders = dueSoon(data.all, now, data.lead, data.perItem)
  const done = data.all.filter((p) => p.status === 'fulfilled' || p.status === 'cancelled').sort((a, b) => b.pickupAt.localeCompare(a.pickupAt)).slice(0, 10)

  const collect = (p: PreOrder) =>
    run(async () => {
      const cartKey = `pos-cart-${terminal.id}`
      const current = JSON.parse(localStorage.getItem(cartKey) ?? '{"lines":[]}')
      if ((current.lines ?? []).length > 0) throw new Error('Finish, hold or clear the cart on the Order screen first')
      const dep = data.deposits.get(p.id)
      localStorage.setItem(cartKey, JSON.stringify({ ...emptyCart(), orderType: p.kind === 'delivery' ? 'takeout' : 'pickup', name: p.customerName, lines: p.lines, ...(p.deliveryFee && { deliveryFee: p.deliveryFee }) }))
      localStorage.setItem(fulfilKey(terminal.id), JSON.stringify({ preOrderId: p.id, label: `${p.customerName} · ${hm(new Date(p.pickupAt))}`, ...(dep && { depositId: dep.id, depositAmount: dep.amount }) }))
      onGo()
    })

  const cancel = (p: PreOrder, approvalId?: string) =>
    run(() => cancelPreOrder({ preOrderId: p.id, userId: user.id, terminalId: terminal.id, reasonCode: reason.code, reasonNote: reason.note, approvalId })).then((ok) => { if (ok) { setCancelling(''); setAsking(false); setReason(NO_REASON) } else setAsking(false) })

  return (
    <section>
      <h2>Pre-orders</h2>
      <Err msg={error} />
      {reminders.map((p) => (
        <p key={p.id} role="status" className="flag">
          <strong>Start now: {p.customerName}, due {hm(new Date(p.pickupAt))}.</strong>{' '}
          <button className="primary" onClick={() => run(() => startPrep(p.id, user.id))}>Start prep</button>
        </p>
      ))}
      {rows.length === 0 && <p className="empty">No pre-orders waiting. Build the order on the Order screen and tap "Pre-order".</p>}
      {rows.map(({ order: p, drinks, bulk, startBy, sameSlot }) => {
        const dep = data.deposits.get(p.id)
        const total = p.lines.reduce((s, l) => s + lineTotal(l), 0) + (p.deliveryFee ?? 0)
        return (
          <div key={p.id} className={`card ${bulk ? 'flag' : ''}`}>
            <div className="row between">
              <strong>{hm(new Date(p.pickupAt))} · {p.customerName} {bulk && <span className="badge">BULK</span>}</strong>
              <span>{p.status === 'preparing' ? 'bar is making it' : 'booked'}</span>
            </div>
            <small>
              {p.kind} · {when(p.pickupAt)} · {drinks} drink(s) · {formatPeso(total)}{p.phone && ` · ${p.phone}`}
              {p.status === 'booked' && ` · start by ${hm(startBy)}`}{sameSlot > drinks && ` · ${sameSlot} drinks due in the same half hour`}
              {dep ? ` · deposit ${formatPeso(dep.amount)} held (${p.depositPolicy === 'refund' ? 'refunded' : 'kept'} if cancelled)` : ' · no deposit'}
              {p.note && ` · ${p.note}`}
            </small>
            <div className="row">
              {p.status === 'booked' && <button onClick={() => run(() => startPrep(p.id, user.id))}>Start prep</button>}
              <button className="primary" onClick={() => collect(p)}>Collect and pay</button>
              <button onClick={() => { setCancelling(cancelling === p.id ? '' : p.id); setAsking(false); setReason(NO_REASON) }}>Cancel</button>
            </div>
            {cancelling === p.id && (
              asking && dep ? (
                <ApprovalPrompt action="refund" amount={dep.amount} requesterId={user.id} orderRef={p.id} title={`Cancelling settles the ${formatPeso(dep.amount)} deposit (${p.depositPolicy === 'refund' ? 'refunded' : 'kept'}): supervisor PIN needed.`}
                  onCancel={() => setAsking(false)} onApproved={(a) => cancel(p, a.id)} />
              ) : (
                <div className="row">
                  <ReasonFields value={reason} onChange={setReason} />
                  <button onClick={() => run(async () => { checkReason(reason.code, reason.note); if (dep) setAsking(true); else await cancelPreOrder({ preOrderId: p.id, userId: user.id, terminalId: terminal.id, reasonCode: reason.code, reasonNote: reason.note }).then(() => setCancelling('')) })}>
                    {dep ? 'Continue to supervisor PIN' : 'Cancel the pre-order'}
                  </button>
                  {p.status === 'preparing' && <small>The bar already started: the drinks count as waste.</small>}
                </div>
              )
            )}
          </div>
        )
      })}
      {done.length > 0 && (
        <>
          <h3>Recent</h3>
          <ul className="lines">
            {done.map((p) => (
              <li key={p.id}>{when(p.pickupAt)} · {p.customerName} · {p.status}{p.cancelled && ` (deposit ${p.cancelled.deposit}${p.cancelled.wasMade ? ', made: waste' : ''})`}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
