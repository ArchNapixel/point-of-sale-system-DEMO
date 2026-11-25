import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import type { Report } from '../lib/reports'
import { PAY_METHODS } from '../lib/payments'
import { DEMO_FOOTER } from '../lib/receipt'
import { formatPeso } from '../lib/money'

const R = ({ l, r, bold }: { l: string; r: string; bold?: boolean }) => (
  <div className="rrow" style={bold ? { fontWeight: 700 } : undefined}><span>{l}</span><span>{r}</span></div>
)

/** One report laid out like a till printout. Used for X (one shift), Z (one day) and the owner's day view. */
export default function ReportView({ title, report: r, onPrint }: { title: string; report: Report; onPrint?: boolean }) {
  const names = useLiveQuery(async () => ({
    users: new Map((await db.users.toArray()).map((u) => [u.id, u.name])),
    terminals: new Map((await db.terminals.toArray()).map((t) => [t.id, t.name])),
  }), [])
  if (!names) return null
  const m = (x: number) => formatPeso(x)
  return (
    <div className="card">
      <div className="receipt print-area">
        <div className="center"><strong>{title}</strong></div>
        <hr />
        <R l={`Orders (${r.orders})  Gross sales`} r={m(r.gross)} />
        {r.discounts.seniorPwd > 0 && <R l="Less Senior/PWD" r={`-${m(r.discounts.seniorPwd)}`} />}
        {r.discounts.promo > 0 && <R l="Less promos" r={`-${m(r.discounts.promo)}`} />}
        {r.discounts.staff > 0 && <R l="Less staff discount" r={`-${m(r.discounts.staff)}`} />}
        <R l={`Voids (${r.voids.count})`} r={`-${m(r.voids.amount)}`} />
        <R l={`Refunds (${r.refunds.count})`} r={`-${m(r.refunds.amount)}`} />
        <R l="NET SALES" r={m(r.net)} bold />
        <R l={`Comps (${r.comps.count}, not in sales)`} r={m(r.comps.value)} />
        {r.deliveryFees > 0 && <R l="Delivery fees (not in sales)" r={m(r.deliveryFees)} />}
        <hr />
        <R l="VATable sales" r={m(r.vat.vatable)} />
        <R l="VAT" r={m(r.vat.vat)} />
        <R l="VAT-exempt sales" r={m(r.vat.vatExempt)} />
        {r.vat.nonVatSales > 0 && <R l="Non-VAT sales" r={m(r.vat.nonVatSales)} />}
        <R l={`Senior/PWD (${r.seniorPwd.count})`} r={m(r.seniorPwd.reduction)} />
        <hr />
        <strong>Payments</strong>
        {PAY_METHODS.filter((p) => ['cash', 'gcash', 'maya', 'card'].includes(p.id) || r.payments[p.id].collected + r.payments[p.id].refunded > 0).map((p) => (
          <R key={p.id} l={`${p.label}  in ${m(r.payments[p.id].collected)}  out ${m(r.payments[p.id].refunded)}`} r={m(r.payments[p.id].net)} />
        ))}
        {r.pending.count > 0 && <R l={`Pending verification (${r.pending.count})`} r={m(r.pending.amount)} />}
        {r.channels.map((c) => <R key={c.channelId} l={`${c.name} (${c.orders}) less ${m(c.commission)} commission`} r={`owed ${m(c.owed)}`} />)}
        {(r.deposits.taken > 0 || r.deposits.held > 0) && <R l={`Deposits: taken ${m(r.deposits.taken)}, refunded ${m(r.deposits.refunded)}, kept ${m(r.deposits.forfeited)}`} r={`still held ${m(r.deposits.held)}`} />}
        <hr />
        <strong>Drawer cash</strong>
        <R l="Opening count" r={m(r.cash.opening)} />
        <R l="+ Cash sales" r={m(r.cash.sales)} />
        <R l="- Cash refunds" r={m(r.cash.refunds)} />
        <R l="+ Paid-in" r={m(r.cash.paidIn)} />
        <R l="- Paid-out" r={m(r.cash.paidOut)} />
        <R l="- Drops to safe" r={m(r.cash.drops)} />
        <R l="EXPECTED" r={m(r.cash.expected)} bold />
        <R l="No-sale opens" r={String(r.noSales)} />
        <R l={`Walkouts (${r.walkouts.count}, a loss)`} r={m(r.walkouts.amount)} />
        <hr />
        <strong>Shifts (each on its own, never netted)</strong>
        {r.shifts.map((s) => (
          <div key={s.shiftId}>
            <R l={`${names.terminals.get(s.terminalId) ?? '?'} · ${names.users.get(s.cashierId) ?? '?'}`} r={s.closed ? `${s.overShort && s.overShort > 0 ? 'over ' : s.overShort && s.overShort < 0 ? 'short ' : ''}${m(Math.abs(s.overShort ?? 0))}` : 'open'} />
            {s.closed && <small>expected {m(s.expected)} · counted {m(s.counted ?? 0)}{s.note && ` · ${s.note}`}</small>}
          </div>
        ))}
        <hr />
        <div className="center"><strong>{DEMO_FOOTER}</strong></div>
      </div>
      {onPrint && <button onClick={() => window.print()}>Print</button>}
    </div>
  )
}
