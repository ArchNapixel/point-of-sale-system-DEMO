import { useState } from 'react'
import { useAuth } from '../auth'
import type { Customer } from '../db/db'
import { createCustomer, searchCustomers } from '../db/customers'
import { Err, useAction } from '../ui'

/** Look a customer up by name or the last 4 digits of their number, or save a new profile (only with their consent). */
export default function CustomerPicker({ onPick, onCancel }: { onPick: (c: Customer) => void; onCancel: () => void }) {
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Customer[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', phone: '', consent: false })
  const { error, run } = useAction()
  if (!user) return null
  return (
    <div className="card">
      <div className="row">
        <input aria-label="Find customer" placeholder="Name or last 4 digits of the number" value={q} autoFocus onChange={(e) => { setQ(e.target.value); run(async () => setFound(await searchCustomers(e.target.value))) }} />
        <button onClick={onCancel}>Cancel</button>
      </div>
      {found?.map((c) => <div key={c.id} className="row between"><span>{c.name} <small>{c.phone ? `····${c.phone.slice(-4)}` : 'no number'}</small></span><button onClick={() => onPick(c)}>Use</button></div>)}
      {found && found.length === 0 && q.trim() && <small>No one found.</small>}
      {!adding ? <button onClick={() => { setAdding(true); setF({ ...f, name: q.replace(/\d/g, '').trim() }) }}>New customer</button> : (
        <form onSubmit={async (e) => { e.preventDefault(); await run(async () => onPick(await createCustomer({ name: f.name, phone: f.phone, consent: f.consent, userId: user.id }))) }}>
          <input aria-label="Name" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input aria-label="Mobile number" placeholder="Mobile number (optional)" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <label><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> The customer agreed we may keep their name and number for loyalty</label>
          <button className="primary" disabled={!f.name.trim() || !f.consent}>Save customer</button>
        </form>
      )}
      <Err msg={error} />
    </div>
  )
}
