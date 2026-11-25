import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Customer } from '../db/db'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { anonymizeCustomer, mergeCustomers, searchCustomers } from '../db/customers'
import { adjustLoyalty, customerBalance, loyaltyFlags } from '../db/loyalty'
import { findCards, reissueGiftCard, sellGiftCard } from '../db/giftcards'
import { can } from '../lib/roles'
import { TENDER_METHODS, type PayMethod } from '../lib/payments'
import { formatPeso, parsePesos } from '../lib/money'
import { DEMO_FOOTER } from '../lib/receipt'
import { Err, useAction } from '../ui'
import ApprovalPrompt from './ApprovalPrompt'
import CustomerPicker from './CustomerPicker'

/** Customers and loyalty, and gift cards. Profiles exist only with consent; loyalty and gift cards are money we owe. */
export default function Customers() {
  const [part, setPart] = useState<'customers' | 'cards'>('customers')
  return (
    <section>
      <h2>Customers</h2>
      <div className="seg">
        <button aria-pressed={part === 'customers'} onClick={() => setPart('customers')}>Customers and loyalty</button>
        <button aria-pressed={part === 'cards'} onClick={() => setPart('cards')}>Gift cards</button>
      </div>
      {part === 'customers' ? <Profiles /> : <GiftCards />}
    </section>
  )
}

function Profiles() {
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [selected, setSelected] = useState('')
  const [adding, setAdding] = useState(false)
  const flags = useLiveQuery(() => loyaltyFlags(), [])
  const { run, error } = useAction()
  if (!user) return null
  return (
    <>
      <div className="row">
        <input aria-label="Find customer" placeholder="Name or last 4 digits" value={q} onChange={(e) => { setQ(e.target.value); run(async () => setResults(await searchCustomers(e.target.value))) }} />
        <button onClick={() => setAdding(!adding)}>New customer</button>
      </div>
      <Err msg={error} />
      {adding && <CustomerPicker onCancel={() => setAdding(false)} onPick={(c) => { setAdding(false); setSelected(c.id) }} />}
      {results.map((c) => <div key={c.id} className="row between"><span>{c.name} <small>{c.phone ? `····${c.phone.slice(-4)}` : ''}</small></span><button onClick={() => setSelected(c.id)}>Open</button></div>)}
      {selected && <Profile id={selected} userId={user.id} role={user.role} onGone={() => setSelected('')} />}
      {can(user.role, 'approve') && flags && (
        <div className="card">
          <h4>Loyalty to look at</h4>
          {flags.adjustments.length === 0 && flags.fast.length === 0 && flags.staffProfiles.length === 0 && <p className="empty">Nothing unusual.</p>}
          {flags.adjustments.map((a) => <p key={a.id}>Added by hand: {a.amount > 0 ? '+' : ''}{a.amount} for {a.name} · {a.note} · {new Date(a.at).toLocaleDateString('en-PH')}</p>)}
          {flags.fast.map((f) => <p key={f.customerId + f.date}><strong>{f.name}</strong> earned from {f.orders} orders on {f.date}.</p>)}
          {flags.staffProfiles.map((s) => <p key={s.customerId}><strong>{s.name}</strong> has a profile named like a staff member and is earning.</p>)}
        </div>
      )}
    </>
  )
}

function Profile({ id, userId, role, onGone }: { id: string; userId: string; role: string; onGone: () => void }) {
  const data = useLiveQuery(async () => ({ c: await db.customers.get(id), b: await customerBalance(id) }), [id])
  const terminals = useLiveQuery(() => db.terminals.filter((t) => t.active).toArray(), [])
  const [panel, setPanel] = useState<'' | 'adjust' | 'merge' | 'forget'>('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const [other, setOther] = useState<Customer[]>([])
  const [mq, setMq] = useState('')
  const { error, run } = useAction()
  if (!data?.c || !terminals) return null
  const { c, b } = data
  const unit = b.programme.mode === 'points' ? 'points' : 'stamps'
  const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  return (
    <div className="card">
      <h3>{c.name} {!c.active && <small>({c.anonymizedAt ? 'removed' : c.mergedInto ? 'merged' : 'inactive'})</small>}</h3>
      <small>{c.phone ? `····${c.phone.slice(-4)} · ` : ''}consent {new Date(c.consentAt).toLocaleDateString('en-PH')}</small>
      {b.programme.mode === 'off' ? <p>Loyalty is switched off in Settings.</p> : (
        <p>
          <strong>{b.balance} {unit}</strong> · a free drink at {b.programme.rewardAt}
          {b.expiringSoon.map((x, i) => <span key={i}> · <strong>{x.amount} expire {new Date(x.expiresAt).toLocaleDateString('en-PH')}</strong></span>)}
        </p>
      )}
      <ul className="lines">
        {b.entries.slice(0, 8).map((e) => <li key={e.id}><small>{new Date(e.at).toLocaleDateString('en-PH')} · {e.kind} {e.amount > 0 ? '+' : ''}{e.amount}{e.note && ` · ${e.note}`}</small></li>)}
      </ul>
      <Err msg={error} />
      {c.active && (
        <div className="row">
          <button onClick={() => { setPanel(panel === 'adjust' ? '' : 'adjust'); setAsking(false) }}>Add or remove by hand</button>
          <button onClick={() => setPanel(panel === 'merge' ? '' : 'merge')}>Merge another profile into this one</button>
          {can(role as never, 'editPrices') && <button onClick={() => setPanel(panel === 'forget' ? '' : 'forget')}>Remove my info</button>}
        </div>
      )}
      {panel === 'adjust' && (asking && terminal ? (
        <ApprovalPrompt action="loyalty" amount={Math.abs(Number(amount))} requesterId={userId} orderRef={c.id} title="Stamps or points added by hand need a supervisor PIN."
          onCancel={() => setAsking(false)} onApproved={(a) => run(() => adjustLoyalty({ customerId: c.id, amount: Number(amount), reason, userId, approvalId: a.id })).then((ok) => { if (ok) { setPanel(''); setAsking(false); setAmount(''); setReason('') } else setAsking(false) })} />
      ) : (
        <div className="row">
          <input aria-label="How many" size={5} inputMode="numeric" placeholder="+5 or -2" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input aria-label="Why" placeholder="Why? (e.g. forgot to ring)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button disabled={!Number(amount) || !reason.trim()} onClick={() => setAsking(true)}>Continue to supervisor PIN</button>
        </div>
      ))}
      {panel === 'merge' && (
        <div>
          <input aria-label="Find the profile to merge in" placeholder="Name or last 4 digits of the old profile" value={mq} onChange={(e) => { setMq(e.target.value); run(async () => setOther((await searchCustomers(e.target.value)).filter((x) => x.id !== c.id))) }} />
          {other.map((o) => <div key={o.id} className="row between"><span>{o.name} <small>{o.phone ? `····${o.phone.slice(-4)}` : ''}</small></span><button onClick={() => run(() => mergeCustomers(c.id, o.id, userId)).then((ok) => ok && setPanel(''))}>Merge into {c.name}</button></div>)}
          <small>All history of the merged profile follows {c.name}.</small>
        </div>
      )}
      {panel === 'forget' && (
        <div className="row">
          <small>The name and number are removed; sales, stamps and points stay without personal details.</small>
          <button className="primary" onClick={() => run(() => anonymizeCustomer(c.id, userId)).then((ok) => { if (ok) onGone() })}>Remove this customer's info</button>
        </div>
      )}
    </div>
  )
}

function GiftCards() {
  const { user } = useAuth()
  const terminals = useLiveQuery(() => db.terminals.filter((t) => t.active).toArray(), [])
  const [q, setQ] = useState('')
  const [cards, setCards] = useState<Awaited<ReturnType<typeof findCards>>>([])
  const [f, setF] = useState({ amount: '', method: 'cash' as PayMethod, ref: '' })
  const [buyer, setBuyer] = useState<Customer | null>(null)
  const [pickBuyer, setPickBuyer] = useState(false)
  const [slip, setSlip] = useState<{ number: string; amount: number } | null>(null)
  const { error, run } = useAction()
  if (!user || !terminals) return null
  const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  const search = (text: string) => run(async () => setCards(await findCards(text)))
  return (
    <>
      <form className="card" onSubmit={(e) => e.preventDefault()}>
        <h4>Sell a gift card</h4>
        <small>Money paid now for drinks later. It is a liability until it is spent, not a sale.</small>
        <div className="row">
          <input aria-label="Card amount" size={9} inputMode="decimal" placeholder="Amount ₱" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <select aria-label="Paid by" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PayMethod })}>{TENDER_METHODS.filter((m) => m.id !== 'giftcard').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          {f.method !== 'cash' && <input aria-label="Payment reference" placeholder="Reference no." value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} />}
        </div>
        {pickBuyer ? <CustomerPicker onCancel={() => setPickBuyer(false)} onPick={(c) => { setBuyer(c); setPickBuyer(false) }} /> : (
          <div className="row"><small>Buyer: {buyer ? buyer.name : 'not recorded (helps find a lost card)'}</small><button type="button" onClick={() => setPickBuyer(true)}>{buyer ? 'Change' : 'Add buyer'}</button></div>
        )}
        <button className="primary" disabled={!terminal || !f.amount} onClick={() => run(async () => {
          const amount = parsePesos(f.amount)
          if (amount === null) throw new Error('Enter the amount in pesos, like 1000')
          const card = await sellGiftCard({ terminalId: terminal!.id, userId: user.id, amount, method: f.method, reference: f.ref, buyerId: buyer?.id })
          setSlip({ number: card.number, amount }); setF({ amount: '', method: 'cash', ref: '' }); setBuyer(null)
        })}>Sell gift card</button>
      </form>
      {slip && (
        <div className="card">
          <div className="receipt print-area"><div className="center"><strong>GIFT CARD</strong><br />{slip.number}<br />Value {formatPeso(slip.amount)}<hr />Not a sales invoice. Keep this card number.<br />{DEMO_FOOTER}</div></div>
          <button onClick={() => window.print()}>Print</button> <button onClick={() => setSlip(null)}>Close</button>
        </div>
      )}
      <div className="row">
        <input aria-label="Find a card" placeholder="Card number or buyer's name" value={q} onChange={(e) => { setQ(e.target.value); search(e.target.value) }} />
      </div>
      <Err msg={error} />
      {cards.map((c) => (
        <div key={c.id} className={`card ${c.status === 'void' ? 'archived-card' : ''}`}>
          <div className="row between">
            <span><strong>{c.number}</strong> {c.buyer && <small>bought by {c.buyer}</small>} {c.status === 'void' && <small>(replaced)</small>}</span>
            <strong>{formatPeso(c.balance)}</strong>
          </div>
          {c.status === 'active' && c.balance > 0 && can(user.role, 'editPrices') && <button onClick={() => run(async () => { const n = await reissueGiftCard(c.id, user.id); setSlip({ number: n.number, amount: c.balance }); await search(q) })}>Reissue on a new card (lost)</button>}
        </div>
      ))}
    </>
  )
}
