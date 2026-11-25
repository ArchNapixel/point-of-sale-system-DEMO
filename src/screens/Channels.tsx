import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Channel } from '../db/db'
import { createChannel, dailyCheck, netOfCommission, receivables, setChannelActive, setChannelPrice, setCommission, settlePayout } from '../db/channels'
import { variantLabel } from '../db/menu'
import { ymdLocal } from '../lib/promos'
import { can } from '../lib/roles'
import { formatPeso, parsePesos } from '../lib/money'
import { Err, useAction } from '../ui'

/** Delivery apps: commission %, their prices, the weekly payout against what they owe, and the daily order-count check. */
export default function Channels() {
  const { user } = useAuth()
  const channels = useLiveQuery(() => db.channels.toArray().then((l) => l.sort((a, b) => a.name.localeCompare(b.name))), [])
  const [name, setName] = useState('')
  const [pctText, setPctText] = useState('20')
  const { error, run } = useAction()
  if (!channels || !user) return null
  const owner = can(user.role, 'editPrices')
  return (
    <section>
      <h2>Delivery apps</h2>
      {owner && (
        <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createChannel(name, Number(pctText), user.id))) setName('') }}>
          <input aria-label="App name" placeholder="GrabFood" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Commission <input aria-label="Commission percent" size={4} inputMode="decimal" value={pctText} onChange={(e) => setPctText(e.target.value)} /> %</label>
          <button className="primary" disabled={!name.trim()}>Add app</button>
        </form>
      )}
      <Err msg={error} />
      {channels.length === 0 && <p className="empty">No delivery apps yet. Orders keyed in under an app are sold at its prices and paid by the app later.</p>}
      {channels.map((c) => <ChannelCard key={c.id} channel={c} owner={owner} userId={user.id} />)}
    </section>
  )
}

function ChannelCard({ channel: c, owner, userId }: { channel: Channel; owner: boolean; userId: string }) {
  const { error, run } = useAction()
  const data = useLiveQuery(async () => {
    const [variants, items, prices] = await Promise.all([db.variants.filter((v) => v.active).toArray(), db.items.filter((i) => i.active).toArray(), db.channelPrices.where('channelId').equals(c.id).toArray()])
    const owed = await receivables(c.id)
    const check = await db.channelChecks.get([c.id, ymdLocal(new Date())])
    return { variants, items, prices: new Map(prices.map((p) => [p.variantId, p.price])), owed, check }
  }, [c.id])
  const [pct, setPct] = useState(String(c.commissionPct))
  const [priceText, setPriceText] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [received, setReceived] = useState('')
  const [reference, setReference] = useState('')
  const [count, setCount] = useState('')
  const [open, setOpen] = useState(false)
  if (!data) return null
  const owedPicked = data.owed.filter((o) => picked[o.id])
  const expected = owedPicked.reduce((s, o) => s + netOfCommission(o.total, o.commissionPct ?? 0), 0)

  return (
    <div className={`card ${c.active ? '' : 'archived-card'}`}>
      <div className="row between">
        <strong>{c.name} <small>{c.commissionPct}% commission</small></strong>
        {owner && (
          <span className="row">
            <input aria-label={`${c.name} commission`} size={4} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
            <button onClick={() => run(() => setCommission(c.id, Number(pct), userId))}>Set %</button>
            <button onClick={() => run(() => setChannelActive(c.id, !c.active, userId))}>{c.active ? 'Archive' : 'Restore'}</button>
          </span>
        )}
      </div>

      <div className="row">
        <small>Daily check today:</small>
        <input aria-label={`${c.name} orders on the app`} size={5} inputMode="numeric" placeholder="orders on the app" value={count} onChange={(e) => setCount(e.target.value)} />
        <button onClick={() => run(async () => { await dailyCheck({ channelId: c.id, date: ymdLocal(new Date()), platformCount: Number(count), userId }) })} disabled={!count}>Check</button>
        {data.check && (data.check.platformCount === data.check.posCount
          ? <small>✓ {data.check.posCount} on both</small>
          : <strong>App shows {data.check.platformCount}, POS has {data.check.posCount}: {Math.abs(data.check.platformCount - data.check.posCount)} order(s) not keyed in</strong>)}
      </div>

      <h4>Owed by {c.name} ({data.owed.length})</h4>
      {data.owed.length === 0 && <p className="empty">Nothing waiting for a payout.</p>}
      {data.owed.map((o) => (
        <label key={o.id} className="row">
          <input type="checkbox" checked={!!picked[o.id]} onChange={(e) => setPicked({ ...picked, [o.id]: e.target.checked })} />
          #{o.number} {new Date(o.paidAt).toLocaleDateString('en-PH')} · sale {formatPeso(o.total)} · after {o.commissionPct}% commission {formatPeso(netOfCommission(o.total, o.commissionPct ?? 0))}
        </label>
      ))}
      {owedPicked.length > 0 && (
        <div className="row">
          <strong>Expected {formatPeso(expected)}</strong>
          <input aria-label="Amount received" size={9} inputMode="decimal" placeholder="Received ₱" value={received} onChange={(e) => setReceived(e.target.value)} />
          <input aria-label="Payout reference" placeholder="Reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          <button className="primary" onClick={() => run(async () => {
            const r = parsePesos(received)
            if (r === null) throw new Error('Enter the amount received in pesos')
            await settlePayout({ channelId: c.id, orderIds: owedPicked.map((o) => o.id), received: r, reference, userId })
            setPicked({}); setReceived(''); setReference('')
          })}>Record payout</button>
          {received && parsePesos(received) !== null && parsePesos(received)! !== expected && <small>Gap {formatPeso(parsePesos(received)! - expected)}: look into it.</small>}
        </div>
      )}

      {owner && (
        <>
          <button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} prices on this app</button>
          {open && (
            <div>
              <small>Leave blank to use the counter price. Add-on prices are the same everywhere.</small>
              {data.variants.map((v) => {
                const item = data.items.find((i) => i.id === v.itemId)
                if (!item) return null
                return (
                  <div key={v.id} className="row">
                    <span style={{ minWidth: '14rem' }}>{item.name} · {variantLabel(v)} <small>counter {formatPeso(v.price)}</small></span>
                    <input aria-label={`${item.name} ${variantLabel(v)} price on ${c.name}`} size={8} inputMode="decimal" placeholder={data.prices.has(v.id) ? String(data.prices.get(v.id)! / 100) : '—'} value={priceText[v.id] ?? ''} onChange={(e) => setPriceText({ ...priceText, [v.id]: e.target.value })} />
                    <button onClick={() => run(async () => { const t = (priceText[v.id] ?? '').trim(); const p = t === '' ? null : parsePesos(t); if (t !== '' && p === null) throw new Error('Enter the price in pesos'); await setChannelPrice(c.id, v.id, p, userId); setPriceText({ ...priceText, [v.id]: '' }) })}>Save</button>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
      <Err msg={error} />
    </div>
  )
}
