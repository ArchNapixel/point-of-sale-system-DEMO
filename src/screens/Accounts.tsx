import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Account } from '../db/db'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { accountBalance, createCorporateAccount, createStaffAccount, receiveAccountPayment, setAccountActive, setCreditLimit, statement } from '../db/accounts'
import { listActiveUsers } from '../db/users'
import { ymdLocal } from '../lib/promos'
import { can } from '../lib/roles'
import { TENDER_METHODS, type PayMethod } from '../lib/payments'
import { formatPeso, parsePesos } from '../lib/money'
import { DEMO_FOOTER } from '../lib/receipt'
import { Err, useAction } from '../ui'

/** Charge accounts: companies that order on credit and pay monthly, and staff meals taken off their pay. */
export default function Accounts() {
  const { user } = useAuth()
  const accounts = useLiveQuery(async () => Promise.all((await db.accounts.toArray()).sort((a, b) => a.name.localeCompare(b.name)).map(async (a) => ({ ...a, balance: await accountBalance(a.id) }))), [])
  const staff = useLiveQuery(listActiveUsers, [])
  const [name, setName] = useState('')
  const [limit, setLimit] = useState('')
  const [staffId, setStaffId] = useState('')
  const { error, run } = useAction()
  if (!accounts || !staff || !user) return null
  const owner = can(user.role, 'editPrices')
  return (
    <section>
      <h2>Charge accounts</h2>
      {owner && (
        <div className="card">
          <form className="row" onSubmit={async (e) => { e.preventDefault(); const l = parsePesos(limit); if (l === null) return void run(() => Promise.reject(new Error('Enter the credit limit in pesos'))); if (await run(() => createCorporateAccount(name, l, user.id))) { setName(''); setLimit('') } }}>
            <input aria-label="Company name" placeholder="Company" value={name} onChange={(e) => setName(e.target.value)} />
            <input aria-label="Credit limit" size={9} inputMode="decimal" placeholder="Limit ₱" value={limit} onChange={(e) => setLimit(e.target.value)} />
            <button className="primary" disabled={!name.trim() || !limit}>Add company account</button>
          </form>
          <div className="row">
            <select aria-label="Staff member" value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="">Staff member…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <button disabled={!staffId} onClick={() => run(async () => { await createStaffAccount(staffId, user.id); setStaffId('') })}>Add staff account</button>
          </div>
        </div>
      )}
      <Err msg={error} />
      {accounts.length === 0 && <p className="empty">No accounts yet.</p>}
      {accounts.map((a) => <AccountCard key={a.id} a={a} owner={owner} userId={user.id} />)}
    </section>
  )
}

function AccountCard({ a, owner, userId }: { a: Account & { balance: number }; owner: boolean; userId: string }) {
  const terminals = useLiveQuery(() => db.terminals.filter((t) => t.active).toArray(), [])
  const [month, setMonth] = useState(ymdLocal(new Date()).slice(0, 7))
  const [open, setOpen] = useState(false)
  const [stmt, setStmt] = useState<Awaited<ReturnType<typeof statement>> | null>(null)
  const [limit, setLimit] = useState('')
  const [pay, setPay] = useState({ amount: '', method: 'cash' as PayMethod, ref: '' })
  const { error, run } = useAction()
  if (!terminals) return null
  const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  return (
    <div className={`card ${a.active ? '' : 'archived-card'}`}>
      <div className="row between">
        <strong>{a.name} <small>{a.kind === 'staff' ? 'staff meals, deducted from pay' : 'company'} · limit {formatPeso(a.creditLimit)}</small></strong>
        <strong>{a.balance > 0 ? `owes ${formatPeso(a.balance)}` : a.balance < 0 ? `credit ${formatPeso(-a.balance)}` : 'settled'}</strong>
      </div>
      <div className="row">
        <input aria-label={`${a.name} month`} size={8} placeholder="2026-11" value={month} onChange={(e) => setMonth(e.target.value)} />
        <button onClick={() => run(async () => { setStmt(await statement(a.id, month)); setOpen(true) })}>Statement</button>
        {owner && (
          <>
            <input aria-label={`${a.name} new limit`} size={8} inputMode="decimal" placeholder="New limit ₱" value={limit} onChange={(e) => setLimit(e.target.value)} />
            <button disabled={!limit} onClick={() => run(async () => { const l = parsePesos(limit); if (l === null) throw new Error('Enter the limit in pesos'); await setCreditLimit(a.id, l, userId); setLimit('') })}>Set limit</button>
            <button onClick={() => run(() => setAccountActive(a.id, !a.active, userId))}>{a.active ? 'Archive' : 'Restore'}</button>
          </>
        )}
      </div>
      {a.balance > 0 && (
        <div className="row">
          <input aria-label={`${a.name} payment`} size={9} inputMode="decimal" placeholder="Received ₱" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
          <select aria-label="Paid by" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as PayMethod })}>{TENDER_METHODS.filter((m) => m.id !== 'giftcard' && m.id !== 'charge').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          {pay.method !== 'cash' && <input aria-label="Payment reference" placeholder="Reference no." value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} />}
          <button className="primary" disabled={!terminal || !pay.amount} onClick={() => run(async () => {
            const amount = parsePesos(pay.amount)
            if (amount === null) throw new Error('Enter the amount in pesos')
            await receiveAccountPayment({ accountId: a.id, amount, method: pay.method, reference: pay.ref, terminalId: terminal!.id, userId })
            setPay({ amount: '', method: 'cash', ref: '' })
          })}>Record payment</button>
        </div>
      )}
      <Err msg={error} />
      {open && stmt && (
        <div className="card">
          <div className="receipt print-area">
            <div className="center"><strong>STATEMENT: {a.name}</strong><br />{month}</div>
            <hr />
            <div className="rrow"><span>Balance brought forward</span><span>{formatPeso(stmt.opening)}</span></div>
            {stmt.lines.map((l) => <div key={l.id} className="rrow"><span>{l.businessDate} {l.kind}{l.invoiceNo ? ` ${l.invoiceNo}` : ''}{l.reference ? ` ref ${l.reference}` : ''}</span><span>{formatPeso(l.amount)}</span></div>)}
            <hr />
            <div className="rrow"><strong>{a.kind === 'staff' ? 'TO DEDUCT FROM PAY / OWED' : 'AMOUNT DUE'}</strong><strong>{formatPeso(stmt.closing)}</strong></div>
            <div className="center">{DEMO_FOOTER}</div>
          </div>
          <button onClick={() => window.print()}>Print</button> <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  )
}
