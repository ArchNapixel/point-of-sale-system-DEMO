import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Bill, type Tab } from '../db/db'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { getSetting } from '../db/settings'
import { buildBill, createTable, setGuests, mergeTabs, moveTab, setLineSeat, setTableActive, tabTotals, transferTab, walkoutTab, type SplitRequest } from '../db/tabs'
import { emptyCart, lineTotal } from '../lib/cart'
import { partToCartLines } from '../lib/split'
import { DEMO_FOOTER } from '../lib/receipt'
import { can } from '../lib/roles'
import { formatPeso, parsePesos } from '../lib/money'
import { Err, useAction } from '../ui'
import ApprovalPrompt from './ApprovalPrompt'
import { billKey } from './Order'

const minutesSince = (iso: string, now: number) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
const hm = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`)

/** Tables and open tabs: rounds through the visit, move, merge, hand over at a shift change, bill out (whole or split), walkout. */
export default function Tabs({ onGo }: { onGo: () => void }) {
  const { user } = useAuth()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  const data = useLiveQuery(async () => {
    const terminals = (await db.terminals.toArray()).filter((t) => t.active)
    const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
    const branchId = terminal?.branchId
    const tables = branchId ? (await db.cafeTables.where('branchId').equals(branchId).toArray()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : []
    const tabs = branchId ? (await db.tabs.where('status').equals('open').toArray()).filter((t) => t.branchId === branchId).sort((a, b) => a.openedAt.localeCompare(b.openedAt)) : []
    const bills = await db.bills.where('tabId').anyOf(tabs.map((t) => t.id)).toArray()
    return { terminal, tables, tabs, bills, minGuests: await getSetting('serviceChargeMinGuests'), svcPct: await getSetting('serviceChargePct'), names: new Map((await db.users.toArray()).map((u) => [u.id, u.name])) }
  }, [])
  const [name, setName] = useState('')
  const [seats, setSeats] = useState('4')
  const { error, run } = useAction()
  if (!data || !user) return null
  if (!data.terminal) return <p>This device is not set up as a store terminal yet.</p>
  const terminal = data.terminal
  const busy = new Set(data.tabs.map((t) => t.tableId))
  const free = data.tables.filter((t) => t.active && !busy.has(t.id))

  return (
    <section>
      <h2>Tables and tabs</h2>
      <Err msg={error} />
      {data.tabs.length === 0 && <p className="empty">No open tabs. Add items on the Order screen and tap "Send to table".</p>}
      {data.tabs.map((t) => (
        <TabCard key={t.id} tab={t} bills={data.bills.filter((b) => b.tabId === t.id).sort((a, b) => b.version - a.version)} names={data.names}
          others={data.tabs.filter((x) => x.id !== t.id)} free={free} terminalId={terminal.id} userId={user.id} now={now} onGo={onGo} minGuests={data.minGuests} svcPct={data.svcPct} />
      ))}
      <h3>Tables</h3>
      {can(user.role, 'manageSetup') && (
        <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createTable(terminal.branchId, name, Number(seats), user.id))) setName('') }}>
          <input aria-label="Table name" placeholder="Table 5, or a tent number" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Seats <input aria-label="Seats" size={4} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} /></label>
          <button className="primary" disabled={!name.trim()}>Add table</button>
        </form>
      )}
      {data.tables.length === 0 && <p className="empty">No tables yet.</p>}
      <ul className="lines">
        {data.tables.map((t) => (
          <li key={t.id} className={`row between ${t.active ? '' : 'archived'}`}>
            <span>{t.name} <small>{t.seats} seats · {busy.has(t.id) ? 'in use' : 'free'}</small></span>
            {can(user.role, 'manageSetup') && <button onClick={() => run(() => setTableActive(t.id, !t.active, user.id))}>{t.active ? 'Archive' : 'Restore'}</button>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function TabCard({ tab, bills, names, others, free, terminalId, userId, now, onGo, minGuests, svcPct }: {
  minGuests: number; svcPct: number; tab: Tab; bills: Bill[]; names: Map<string, string>; others: Tab[]; free: { id: string; name: string }[]; terminalId: string; userId: string; now: number; onGo: () => void
}) {
  const { error, run } = useAction()
  const [panel, setPanel] = useState<'' | 'move' | 'merge' | 'split' | 'walkout'>('')
  const [pick, setPick] = useState('')
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const totals = tabTotals(tab)
  const latest = bills[0]
  const rounds = [...new Set(tab.lines.map((l) => l.round))].sort((a, b) => a - b)

  const payPart = (bill: Bill, partId: string) =>
    run(async () => {
      if (!bill || bill.status !== 'open') throw new Error('This bill was replaced. Use the newest bill.')
      const part = bill.parts.find((p) => p.id === partId)!
      const cartKey = `pos-cart-${terminalId}`
      const current = JSON.parse(localStorage.getItem(cartKey) ?? '{"lines":[]}')
      if ((current.lines ?? []).length > 0) throw new Error('Finish, hold or clear the cart on the Order screen first')
      localStorage.setItem(cartKey, JSON.stringify({ ...emptyCart(), orderType: 'dine-in', table: tab.label, lines: partToCartLines(part, tab.lines), ...((tab.guests ?? 0) >= minGuests && { serviceCharge: true }) }))
      localStorage.setItem(billKey(terminalId), JSON.stringify({ tabId: tab.id, billId: bill.id, partId, label: `${tab.label} · ${part.label}` }))
      onGo()
    })

  return (
    <div className="card">
      <div className="row between">
        <strong>Table {tab.label} <small>open {hm(minutesSince(tab.openedAt, now))} · {names.get(tab.cashierId)}</small></strong>
        <strong>{formatPeso(totals.due)} <small>of {formatPeso(totals.total)}</small></strong>
      </div>
      <div className="row">
        <label>Guests <input aria-label="Guests" size={4} inputMode="numeric" value={tab.guests ?? ''} onChange={(e) => run(() => setGuests(tab.id, Number(e.target.value || 0), userId))} /></label>
        {(tab.guests ?? 0) >= minGuests && <small>{minGuests}+ guests: the {svcPct}% service charge is added when you pay (untick it on the Order screen if the customer declines).</small>}
      </div>
      {rounds.map((r) => (
        <div key={r}>
          <small>Round {r}</small>
          {tab.lines.filter((l) => l.round === r).map((l) => (
            <div key={l.id} className="row between">
              <span>
                {l.qty}× {l.name} <small>{l.variantLabel}{l.mods.length > 0 && ` · ${l.mods.map((m) => m.name).join(', ')}`} · {names.get(l.addedBy)}{l.fromTable && ` · from table ${l.fromTable}`}</small>
                {tab.settled[l.id] !== undefined && tab.settled[l.id] >= lineTotal(l) && <small> · PAID</small>}
              </span>
              <span className="row">
                <input aria-label={`Seat for ${l.name}`} size={3} inputMode="numeric" placeholder="seat" value={l.seat ?? ''} onChange={(e) => run(() => setLineSeat(tab.id, l.id, e.target.value ? Number(e.target.value) : undefined, userId))} />
                <strong>{l.comp ? 'COMP' : formatPeso(lineTotal(l))}</strong>
              </span>
            </div>
          ))}
        </div>
      ))}
      <Err msg={error} />
      <div className="row">
        <button onClick={() => setPanel(panel === 'move' ? '' : 'move')}>Move</button>
        <button onClick={() => setPanel(panel === 'merge' ? '' : 'merge')} disabled={others.length === 0}>Merge</button>
        {tab.cashierId !== userId && <button onClick={() => run(() => transferTab({ tabId: tab.id, terminalId, userId }))}>Take over</button>}
        <button className="primary" onClick={() => setPanel(panel === 'split' ? '' : 'split')} disabled={totals.due === 0}>Bill</button>
        <button onClick={() => { setAsking(false); setPanel(panel === 'walkout' ? '' : 'walkout') }}>Walkout</button>
      </div>
      {panel === 'move' && (
        <div className="row">
          <select aria-label="Move to" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Free table…</option>{free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <button disabled={!pick} onClick={() => run(() => moveTab(tab.id, pick, userId)).then((ok) => ok && setPanel(''))}>Move tab</button>
        </div>
      )}
      {panel === 'merge' && (
        <div className="row">
          <select aria-label="Merge with" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Merge in tab…</option>{others.map((t) => <option key={t.id} value={t.id}>Table {t.label}</option>)}</select>
          <button disabled={!pick} onClick={() => run(() => mergeTabs(tab.id, pick, userId)).then((ok) => ok && setPanel(''))}>Merge into this tab</button>
        </div>
      )}
      {panel === 'split' && <SplitForm tab={tab} onBuild={(req) => run(() => buildBill(tab.id, req, userId)).then((ok) => ok && setPanel(''))} />}
      {panel === 'walkout' && (
        asking ? (
          <ApprovalPrompt
            action="walkout" amount={totals.due} requesterId={userId} orderRef={tab.id} title={`Walkout of ${formatPeso(totals.due)}: supervisor PIN needed.`}
            onCancel={() => setAsking(false)}
            onApproved={(a) => run(() => walkoutTab({ tabId: tab.id, terminalId, userId, reason, approvalId: a.id })).then((ok) => { if (ok) setPanel(''); else setAsking(false) })}
          />
        ) : (
          <div className="row">
            <input aria-label="Walkout reason" placeholder="What happened?" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={!reason.trim()} onClick={() => setAsking(true)}>Continue to supervisor PIN</button>
          </div>
        )
      )}
      {bills.map((b) => <BillBlock key={b.id} bill={b} tab={tab} current={b.id === latest?.id} onPay={(partId) => payPart(b, partId)} />)}
    </div>
  )
}

function SplitForm({ tab, onBuild }: { tab: Tab; onBuild: (r: SplitRequest) => void }) {
  const [mode, setMode] = useState<'whole' | 'item' | 'seat' | 'even' | 'custom'>('whole')
  const [payers, setPayers] = useState('2')
  const [assign, setAssign] = useState<Record<string, number[]>>({})
  const [amounts, setAmounts] = useState<string[]>(['', ''])
  const n = Math.max(1, Math.min(20, Number(payers) || 1))
  const toggle = (lineId: string, p: number) => setAssign({ ...assign, [lineId]: (assign[lineId] ?? []).includes(p) ? (assign[lineId] ?? []).filter((x) => x !== p) : [...(assign[lineId] ?? []), p].sort() })
  const build = () => {
    if (mode === 'whole') return onBuild({ mode })
    if (mode === 'seat') return onBuild({ mode })
    if (mode === 'even') return onBuild({ mode, payers: n })
    if (mode === 'item') return onBuild({ mode, payers: n, assign })
    const parsed = amounts.map((a) => parsePesos(a))
    return onBuild({ mode: 'custom', amounts: parsed.map((x) => x ?? 0) })
  }
  return (
    <div className="card">
      <div className="seg">
        {([['whole', 'Whole bill'], ['item', 'By item / share an item'], ['seat', 'By seat'], ['even', 'Evenly'], ['custom', 'Custom amounts']] as const).map(([m, l]) => (
          <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>
      {(mode === 'item' || mode === 'even') && <label>Payers <input aria-label="Number of payers" size={3} inputMode="numeric" value={payers} onChange={(e) => setPayers(e.target.value)} /></label>}
      {mode === 'item' && tab.lines.map((l) => (
        <div key={l.id} className="row">
          <span style={{ minWidth: '10rem' }}>{l.name} {formatPeso(lineTotal(l))}</span>
          {Array.from({ length: n }, (_, p) => <label key={p}><input type="checkbox" checked={(assign[l.id] ?? []).includes(p)} onChange={() => toggle(l.id, p)} /> {p + 1}</label>)}
        </div>
      ))}
      {mode === 'item' && <small>Tick one payer for a whole item; tick several to share it equally (a cake in thirds).</small>}
      {mode === 'custom' && (
        <div className="row">
          {amounts.map((a, i) => <input key={i} aria-label={`Amount ${i + 1}`} size={8} inputMode="decimal" placeholder={`Payer ${i + 1} ₱`} value={a} onChange={(e) => setAmounts(amounts.map((x, j) => (j === i ? e.target.value : x)))} />)}
          <button onClick={() => setAmounts([...amounts, ''])}>+ payer</button>
        </div>
      )}
      <button className="primary" onClick={build}>Print bill</button>
    </div>
  )
}

function BillBlock({ bill, tab, current, onPay }: { bill: Bill; tab: Tab; current: boolean; onPay: (partId: string) => void }) {
  const [printing, setPrinting] = useState(false)
  return (
    <div className="card" style={bill.status === 'superseded' ? { opacity: 0.6 } : undefined}>
      <div className="row between">
        <strong>Bill v{bill.version} <small>{bill.mode} · {bill.status === 'superseded' ? 'SUPERSEDED: do not pay from this' : bill.status}</small></strong>
        {current && bill.status === 'open' && <button onClick={() => setPrinting(!printing)}>{printing ? 'Hide' : 'Print view'}</button>}
      </div>
      {bill.parts.map((p) => (
        <div key={p.id} className="row between">
          <span>{p.label} <small>{p.lines.map((l) => `${l.name}${l.share ? ` 1/${l.share.n}` : ''}`).join(', ')}</small></span>
          <span className="row">
            <strong>{formatPeso(p.amount)}</strong>
            {p.paidOrderId ? <small>PAID</small> : <button disabled={bill.status !== 'open'} onClick={() => onPay(p.id)}>Pay</button>}
          </span>
        </div>
      ))}
      {printing && (
        <>
          <div className="receipt print-area">
            <div className="center"><strong>BILL: table {tab.label}</strong><br />Version {bill.version}</div>
            <hr />
            {bill.parts.map((p) => (
              <div key={p.id}>
                <strong>{p.label}</strong>
                {p.lines.map((l, i) => <div key={i} className="rrow"><span>{l.name}{l.share ? ` (1/${l.share.n})` : ''}</span><span>{formatPeso(l.amount)}</span></div>)}
                <div className="rrow"><strong>Total</strong><strong>{formatPeso(p.amount)}</strong></div>
                <hr />
              </div>
            ))}
            <div className="center"><strong>THIS IS A BILL, NOT AN INVOICE</strong><br />{DEMO_FOOTER}</div>
          </div>
          <button onClick={() => window.print()}>Print</button>
        </>
      )}
    </div>
  )
}
