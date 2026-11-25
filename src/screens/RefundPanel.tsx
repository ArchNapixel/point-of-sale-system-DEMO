import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { pickedAmount, refundableLines, refundOrder, voidOrder } from '../db/refunds'
import { newId } from '../lib/id'
import { checkReason } from '../lib/reasons'
import { PAY_METHODS, type PayMethod } from '../lib/payments'
import { formatPeso } from '../lib/money'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { Err, useAction } from '../ui'
import ApprovalPrompt from './ApprovalPrompt'
import ReasonFields, { NO_REASON } from './ReasonFields'

/**
 * Void (whole order, nothing made yet) or Refund (after it was made: whole or part). Fill in what and why,
 * then a supervisor PIN is always asked. The key is made once per open panel, so a double tap cannot refund twice.
 */
export default function RefundPanel({ orderId, mode, userId, onDone }: { orderId: string; mode: 'void' | 'refund'; userId: string; onDone: () => void }) {
  const data = useLiveQuery(async () => ({ order: await db.orders.get(orderId), rows: await refundableLines(orderId), terminals: (await db.terminals.toArray()).filter((t) => t.active) }), [orderId])
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [method, setMethod] = useState<PayMethod>('cash')
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState(NO_REASON)
  const [step, setStep] = useState<'form' | 'approve'>('form')
  const [key] = useState(newId)
  const { error, run } = useAction()
  if (!data?.order) return null
  const { order, rows } = data
  const terminal = resolveTerminal(data.terminals, localStorage.getItem(DEVICE_KEY))
  const amount = mode === 'void' ? order.total : pickedAmount(rows, picks)
  const label = mode === 'void' ? 'Void this order' : 'Refund'

  if (step === 'approve' && terminal) {
    return (
      <ApprovalPrompt
        action={mode}
        amount={amount}
        requesterId={userId}
        orderRef={orderId}
        title={`${label} ${formatPeso(amount)}: supervisor PIN needed.`}
        onCancel={() => setStep('form')}
        onApproved={(a) =>
          run(async () => {
            const common = { orderId, terminalId: terminal.id, userId, reasonCode: reason.code, reasonNote: reason.note, approvalId: a.id, idempotencyKey: key }
            if (mode === 'void') await voidOrder(common)
            else await refundOrder({ ...common, picks, method, reference })
            onDone()
          }).then((ok) => { if (!ok) setStep('form') })
        }
      />
    )
  }
  return (
    <div className="card">
      <h4>{label}: invoice {order.invoiceNo}</h4>
      {mode === 'void' ? (
        <p>The whole order of {formatPeso(order.total)} is cancelled and handed back the way it was paid. Only possible before anything is made. The invoice number stays and is marked VOID.</p>
      ) : (
        <>
          <small>Tick what to refund. Dated today and taken from today's drawer, linked to the original invoice.</small>
          {rows.map((r) => (
            <div key={r.line.id} className="row between">
              <label>
                <input type="checkbox" disabled={r.remainingUnits === 0 || r.net === 0} checked={!!picks[r.line.id]} onChange={(e) => setPicks({ ...picks, [r.line.id]: e.target.checked ? r.remainingUnits : 0 })} />{' '}
                {r.line.name} <small>{r.line.variantLabel} · paid {formatPeso(r.net)}{r.doneUnits > 0 && ` · ${r.doneUnits} already refunded`}</small>
              </label>
              {r.remainingUnits > 1 && !!picks[r.line.id] && (
                <input aria-label={`Units of ${r.line.name} to refund`} type="number" min={1} max={r.remainingUnits} value={picks[r.line.id]} onChange={(e) => setPicks({ ...picks, [r.line.id]: Number(e.target.value) })} style={{ width: '4rem' }} />
              )}
            </div>
          ))}
          <div className="row">
            <label>Refund to{' '}
              <select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
                {PAY_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            {method !== 'cash' && <input aria-label="Refund reference" placeholder="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />}
          </div>
        </>
      )}
      <div className="row"><ReasonFields value={reason} onChange={setReason} /></div>
      <p>Amount <strong>{formatPeso(amount)}</strong></p>
      <Err msg={error} />
      <div className="row">
        <button onClick={onDone}>Cancel</button>
        <button
          className="primary"
          disabled={amount <= 0 && mode === 'refund'}
          onClick={() => run(async () => { checkReason(reason.code, reason.note); if (!terminal) throw new Error('This device has no terminal yet'); setStep('approve') })}
        >
          Continue to supervisor PIN
        </button>
      </div>
    </div>
  )
}
