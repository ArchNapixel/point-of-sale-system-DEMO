import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { recordCash } from '../db/cash'
import { expectedCash } from '../db/shifts'
import { getSetting } from '../db/settings'
import { CASH_KINDS, type CashKind } from '../lib/cash'
import { newId } from '../lib/id'
import { formatPeso, parsePesos } from '../lib/money'
import { Err, useAction } from '../ui'
import ApprovalPrompt from './ApprovalPrompt'

/** Drops to the safe, paid-outs, paid-ins and no-sale opens for this drawer. Each needs a reason and a supervisor PIN. */
export default function CashMovements({ shiftId, userId }: { shiftId: string; userId: string }) {
  const rows = useLiveQuery(() => db.cashMovements.where('shiftId').equals(shiftId).toArray().then((r) => r.sort((a, b) => b.at.localeCompare(a.at))), [shiftId])
  const drawer = useLiveQuery(async () => ({ cash: await expectedCash(shiftId), limit: await getSetting('cashDropLimitCentavos') }), [shiftId, rows?.length])
  const approvers = useLiveQuery(() => db.users.toArray().then((u) => new Map(u.map((x) => [x.id, x.name]))), [])
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<CashKind>('drop')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [receiptRef, setReceiptRef] = useState('')
  const [asking, setAsking] = useState(false)
  const [key, setKey] = useState(newId)
  const { error, run } = useAction()
  if (!rows || !drawer || !approvers) return null
  const cents = kind === 'no-sale' ? 0 : parsePesos(amount)
  const valid = cents !== null && (kind === 'no-sale' || cents > 0) && reason.trim() !== ''
  const reset = () => { setOpen(false); setAsking(false); setAmount(''); setReason(''); setReceiptRef(''); setKey(newId()) }

  return (
    <div className="card">
      <h4>Cash in the drawer</h4>
      {drawer.cash > drawer.limit && (
        <p role="status"><strong>The drawer is over {formatPeso(drawer.limit)}.</strong> Ask a supervisor for a cash drop to the safe.</p>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)}>Cash drop, paid-out, paid-in or no-sale</button>
      ) : asking ? (
        <ApprovalPrompt
          action="cash"
          amount={cents ?? 0}
          requesterId={userId}
          orderRef={shiftId}
          title={`${CASH_KINDS.find((k) => k.id === kind)?.label}${kind === 'no-sale' ? '' : ` ${formatPeso(cents ?? 0)}`}: supervisor PIN needed.`}
          onCancel={() => setAsking(false)}
          onApproved={(a) => run(() => recordCash({ shiftId, userId, kind, amount: cents ?? 0, reason, receiptRef, approvalId: a.id, idempotencyKey: key })).then((ok) => (ok ? reset() : setAsking(false)))}
        />
      ) : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); setAsking(true) }}>
          <select aria-label="Kind of cash movement" value={kind} onChange={(e) => setKind(e.target.value as CashKind)}>
            {CASH_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          {kind !== 'no-sale' && <input aria-label="Amount" inputMode="decimal" placeholder="Amount (₱)" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          {kind === 'paid-out' && <input aria-label="Receipt number" placeholder="Receipt no. / note" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} />}
          <button type="button" onClick={reset}>Cancel</button>
          <button className="primary" disabled={!valid}>Continue to supervisor PIN</button>
        </form>
      )}
      <Err msg={error} />
      {rows.length > 0 && (
        <ul className="lines">
          {rows.map((m) => (
            <li key={m.id} className="row between">
              <span>
                {new Date(m.at).toLocaleTimeString('en-PH', { timeStyle: 'short' })} · {CASH_KINDS.find((k) => k.id === m.kind)?.label} · {m.reason}
                {m.receiptRef && ` · ${m.receiptRef}`} <small>approved by {approvers.get(m.approvedBy)}{m.approvedBy === m.userId && ' (SELF)'}</small>
              </span>
              {m.kind !== 'no-sale' && <strong>{m.kind === 'paid-in' ? '+' : '−'}{formatPeso(m.amount)}</strong>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
