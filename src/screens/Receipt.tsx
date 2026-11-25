import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { getSetting } from '../db/settings'
import { logPrint } from '../db/orders'
import { NO_LIMITS, needsApproval } from '../lib/approval'
import { useState } from 'react'
import ApprovalPrompt from './ApprovalPrompt'
import { invoiceFigures } from '../lib/invoice'
import { lineTotal } from '../lib/cart'
import { REASONS } from '../lib/reasons'
import { PAY_METHODS } from '../lib/payments'
import { DEMO_FOOTER } from '../lib/receipt'
import { formatPeso } from '../lib/money'
import { Err, useAction } from '../ui'

const R = ({ l, r, bold }: { l: string; r: string; bold?: boolean }) => (
  <div className="rrow" style={bold ? { fontWeight: 700 } : undefined}><span>{l}</span><span>{r}</span></div>
)

/** The sales invoice, laid out for a receipt printer (browser print). Shows REPRINT once it has been printed before. */
export default function Receipt({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { user } = useAuth()
  const { error, run } = useAction()
  const [asking, setAsking] = useState(false)
  const data = useLiveQuery(async () => {
    const order = await db.orders.get(orderId)
    if (!order) return null
    const [payments, cashier, prints] = await Promise.all([
      db.payments.where('orderId').equals(orderId).toArray(),
      db.users.get(order.cashierId),
      db.invoicePrints.where('orderId').equals(orderId).count(),
    ])
    const store = { name: await getSetting('storeName'), tin: await getSetting('storeTin'), address: await getSetting('storeAddress') }
    const v = order.status === 'void' ? await db.refunds.where('orderId').equals(orderId).first() : undefined
    const voided = v && { reasonLabel: REASONS.find((r) => r.id === v.reasonCode)?.label ?? v.reasonCode, approver: (await db.users.get(v.approvedBy))?.name ?? '' }
    const gift = await Promise.all((await db.giftCardTx.where('orderId').equals(orderId).filter((t) => t.kind === 'redeem').toArray()).map(async (t) => ({ ...t, number: (await db.giftCards.get(t.cardId))?.number ?? '' })))
    return { order, payments, cashier, prints, store, voided, gift }
  }, [orderId])
  if (!data || !user) return null
  const { order: o, payments, cashier, prints, store, voided, gift } = data
  const f = invoiceFigures(o)
  const otherLabel = o.promo ? `Promo: ${o.promo.name}` : o.employee ? `Staff discount (${o.employee.name})` : ''
  const d = o.discount
  const change = payments.reduce((s, p) => s + p.tendered - p.amount, 0)
  return (
    <div className="card">
      <div className="receipt print-area">
        {o.status === 'void' && <div className="reprint">VOID{voided ? `: ${voided.reasonLabel} (approved by ${voided.approver})` : ''}</div>}
        {prints > 0 && <div className="reprint">REPRINT</div>}
        <div className="center"><strong>{store.name}</strong><br />TIN {store.tin}<br />{store.address}</div>
        <div className="center"><strong>SALES INVOICE</strong></div>
        <R l="Invoice no." r={o.invoiceNo} bold />
        <R l="Date" r={new Date(o.paidAt).toLocaleString('en-PH')} />
        <R l="Cashier" r={cashier?.name ?? ''} />
        <R l="Order no." r={`#${o.number}`} />
        {o.buyer && <><R l="Sold to" r={o.buyer.name} /><R l="Buyer TIN" r={o.buyer.tin} /></>}
        <hr />
        {o.lines.map((l) => (
          <div key={l.id}>
            <R l={`${l.qty}× ${l.name} ${l.variantLabel}`} r={l.comp ? 'COMP' : formatPeso(lineTotal(l))} />
            {l.mods.length > 0 && <small>&nbsp;&nbsp;{l.mods.map((m) => `${m.name}${m.qty > 1 ? ` ×${m.qty}` : ''}`).join(', ')}</small>}
          </div>
        ))}
        <hr />
        {f.vatRegistered ? (
          <>
            <R l="VATable sales" r={formatPeso(f.vatable)} />
            <R l="VAT 12%" r={formatPeso(f.vat)} />
            <R l="VAT-exempt sales" r={formatPeso(f.vatExempt)} />
            {f.discount > 0 && <R l={`Less ${d?.kind === 'pwd' ? 'PWD' : 'Senior'} 20%`} r={`-${formatPeso(f.discount)}`} />}
            {f.other > 0 && <R l={`${otherLabel} (already off the sales above)`} r={`-${formatPeso(f.other)}`} />}
          </>
        ) : (
          <>
            <R l="Sales" r={formatPeso(f.sales)} />
            {f.discount > 0 && <R l={`Less ${d?.kind === 'pwd' ? 'PWD' : 'Senior'} 20%`} r={`-${formatPeso(f.discount)}`} />}
            {f.other > 0 && <R l={`Less ${otherLabel}`} r={`-${formatPeso(f.other)}`} />}
            <div className="center">NON-VAT REGISTERED</div>
          </>
        )}
        {f.fee > 0 && <R l="Delivery fee (not a sale)" r={formatPeso(f.fee)} />}
        {f.service > 0 && <R l="Service charge (for staff)" r={formatPeso(f.service)} />}
        {f.tip > 0 && <R l="Tip (for staff)" r={formatPeso(f.tip)} />}
        <R l="AMOUNT DUE" r={formatPeso(f.due + f.fee + f.service + f.tip)} bold />
        {payments.map((p) => (
          <R key={p.id} l={`${PAY_METHODS.find((m) => m.id === p.method)?.label}${p.reference ? ` ref ${p.reference}` : ''}${p.last4 ? ` ····${p.last4}` : ''}`} r={formatPeso(p.tendered)} />
        ))}
        {change > 0 && <R l="Change" r={formatPeso(change)} />}
        {gift.map((g) => <R key={g.id} l={`Gift card ${g.number}: balance`} r={formatPeso(g.balanceAfter)} />)}
        {d && (
          <>
            <hr />
            <div>{d.kind === 'pwd' ? 'PWD' : 'Senior Citizen'}: {d.name}</div>
            <div>ID no.: {d.idNumber}</div>
            <div style={{ marginTop: '1.2rem' }}>Signature: ____________________</div>
          </>
        )}
        <hr />
        <div className="center"><strong>{DEMO_FOOTER}</strong></div>
      </div>
      <Err msg={error} />
      {asking && (
        <ApprovalPrompt
          action="reprint"
          amount={0}
          requesterId={user.id}
          orderRef={o.id}
          title="Reprinting an invoice needs a supervisor PIN."
          onCancel={() => setAsking(false)}
          onApproved={(a) => { setAsking(false); run(async () => { await logPrint(o.id, user.id, a.id); window.print() }) }}
        />
      )}
      <div className="row">
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => (prints > 0 && needsApproval(user.role, 'reprint', 0, NO_LIMITS) ? setAsking(true) : run(async () => { await logPrint(o.id, user.id); window.print() }))}>
          {prints > 0 ? 'Reprint' : 'Print'}
        </button>
      </div>
    </div>
  )
}
