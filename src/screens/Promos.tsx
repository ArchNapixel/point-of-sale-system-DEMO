import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { createPromo, setPromoActive } from '../db/promos'
import { can } from '../lib/roles'
import { formatPeso, parsePesos } from '../lib/money'
import type { PromoKind } from '../lib/promos'
import { Err, useAction } from '../ui'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const KINDS: { id: PromoKind; label: string }[] = [
  { id: 'percent', label: '% off' },
  { id: 'amount', label: '₱ off the order' },
  { id: 'b1t1', label: 'Buy 1 Take 1 (cheaper is free)' },
]
const blank = { name: '', kind: 'percent' as PromoKind, value: '', minSpend: '', days: [] as number[], from: '', to: '', startDate: '', endDate: '', appliesToMods: false, code: '', maxUses: '' }

/** Owner enters promos by hand. A promo with a code is a voucher the cashier types; maxUses 1 makes it single-use. */
export default function Promos() {
  const { user } = useAuth()
  const promos = useLiveQuery(async () => {
    const list = await db.promos.toArray()
    const uses = await db.promoUses.toArray()
    return list.map((p) => ({ ...p, used: uses.filter((u) => u.promoId === p.id).length, saved: uses.filter((u) => u.promoId === p.id).reduce((s, u) => s + u.amount, 0) }))
  }, [])
  const [f, setF] = useState(blank)
  const { error, run } = useAction()
  if (!promos || !user) return null
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setF({ ...f, [k]: v })

  const submit = () =>
    run(async () => {
      const value = f.kind === 'b1t1' ? 0 : f.kind === 'percent' ? Number(f.value) : parsePesos(f.value)
      const minSpend = f.minSpend === '' ? 0 : parsePesos(f.minSpend)
      if (value === null || Number.isNaN(value)) throw new Error('Enter the amount off')
      if (minSpend === null) throw new Error('Enter the minimum spend in pesos')
      await createPromo({ ...f, value, minSpend, maxUses: f.maxUses === '' ? 0 : Number(f.maxUses) }, user.id)
      setF(blank)
    })

  return (
    <section>
      <h2>Promos</h2>
      {can(user.role, 'editPrices') && (
        <form className="card settings" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <h3>New promo</h3>
          <label>Name<input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Happy hour" /></label>
          <label>Type
            <select value={f.kind} onChange={(e) => set('kind', e.target.value as PromoKind)}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
          </label>
          {f.kind !== 'b1t1' && <label>{f.kind === 'percent' ? 'Percent off' : 'Pesos off'}<input inputMode="decimal" value={f.value} onChange={(e) => set('value', e.target.value)} /></label>}
          <label>Minimum spend (₱, optional)<input inputMode="decimal" value={f.minSpend} onChange={(e) => set('minSpend', e.target.value)} /></label>
          <div className="row">
            {DAYS.map((d, i) => (
              <label key={d}><input type="checkbox" checked={f.days.includes(i)} onChange={(e) => set('days', e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i))} /> {d}</label>
            ))}
            <small>(no day ticked = every day)</small>
          </div>
          <label>From time<input type="time" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
          <label>Until time<input type="time" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
          <label>Starts on<input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
          <label>Last day<input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></label>
          {f.kind === 'percent' && <label>Also take off add-ons<input type="checkbox" checked={f.appliesToMods} onChange={(e) => set('appliesToMods', e.target.checked)} /></label>}
          <label>Voucher code (optional)<input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="FREECOFFEE-0042" /></label>
          {f.code && <label>Times the code can be used (1 = single-use, 0 = unlimited)<input inputMode="numeric" value={f.maxUses} onChange={(e) => set('maxUses', e.target.value)} /></label>}
          <Err msg={error} />
          <button className="primary">Save promo</button>
        </form>
      )}
      {promos.length === 0 && <p className="empty">No promos yet.</p>}
      <ul className="lines">
        {promos.map((p) => (
          <li key={p.id} className={`row between ${p.active ? '' : 'archived'}`}>
            <span>
              <strong>{p.name}</strong>{' '}
              <small>
                {p.kind === 'percent' ? `${p.value}% off` : p.kind === 'amount' ? `${formatPeso(p.value)} off` : 'Buy 1 Take 1'}
                {p.minSpend > 0 && ` · min ${formatPeso(p.minSpend)}`}
                {p.days.length > 0 && ` · ${p.days.map((d) => DAYS[d]).join('/')}`}
                {(p.from || p.to) && ` · ${p.from || '00:00'}–${p.to || '24:00'}`}
                {(p.startDate || p.endDate) && ` · ${p.startDate || '…'} to ${p.endDate || '…'}`}
                {p.code && ` · code ${p.code}${p.maxUses ? ` (${p.used}/${p.maxUses} used)` : ''}`}
                {` · used ${p.used}× saving ${formatPeso(p.saved)}`}
              </small>
            </span>
            {can(user.role, 'editPrices') && <button onClick={() => run(() => setPromoActive(p.id, !p.active, user.id))}>{p.active ? 'Switch off' : 'Switch on'}</button>}
          </li>
        ))}
      </ul>
    </section>
  )
}
