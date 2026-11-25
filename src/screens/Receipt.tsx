import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { getSetting } from '../db/settings'
import { logPrint } from '../db/orders'
import { invoiceFigures } from '../lib/invoice'
import { lineTotal } from '../lib/cart'
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
  const data = useLiveQuery(async () => {
    const order = await db.orders.get(orderId)
    if (!order) return null
    const [payments, cashier, prints] = await Promise.all([
      db.payments.where('orderId').equals(orderId).toArray(),
      db.users.get(order.cashierId),
      db.invoicePrints.where('orderId').equals(orderId).count(),
    ])
    const store = { name: await getSetting('storeName'), tin: await getSetting('storeTin'), address: await getSetting('storeAddress') }
    return { order, payments, cashier, prints, store }
  }, [orderId])
  if (!data || !user) return null
  const { order: o, payments, cashier, prints, store } = data
  const f = invoiceFigures(o)
  const d = o.discount
  const change = payments.reduce((s, p) => s + p.tendered - p.amount, 0)
  return (
    <div className="card">
      <div className="receipt print-area">
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
            <R l={`${l.qty}× ${l.name} ${l.variantLabel}`} r={formatPeso(lineTotal(l))} />
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
          </>
        ) : (
          <>
            <R l="Sales" r={formatPeso(f.sales)} />
            {f.discount > 0 && <R l={`Less ${d?.kind === 'pwd' ? 'PWD' : 'Senior'} 20%`} r={`-${formatPeso(f.discount)}`} />}
            <div className="center">NON-VAT REGISTERED</div>
          </>
        )}
        <R l="AMOUNT DUE" r={formatPeso(f.due)} bold />
        {payments.map((p) => (
          <R key={p.id} l={`${PAY_METHODS.find((m) => m.id === p.method)?.label}${p.reference ? ` ref ${p.reference}` : ''}${p.last4 ? ` ····${p.last4}` : ''}`} r={formatPeso(p.tendered)} />
        ))}
        {change > 0 && <R l="Change" r={formatPeso(change)} />}
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
      <div className="row">
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => run(async () => { await logPrint(o.id, user.id); window.print() })}>
          {prints > 0 ? 'Reprint' : 'Print'}
        </button>
      </div>
    </div>
  )
}
