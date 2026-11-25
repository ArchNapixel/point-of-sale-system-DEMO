import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type QueueItem } from '../db/db'
import { remakeItem, setItemStatus, setRush, undoStatus } from '../db/queue'
import { can } from '../lib/roles'
import ReasonFields, { NO_REASON } from './ReasonFields'
import { FLOW, RUSH_REASONS, STATUS_ACTION, UNDO_MS, byUrgency, orderReady, waitEstimate } from '../lib/queue'
import { getSetting } from '../db/settings'
import { Err, useAction } from '../ui'
import CupLabels from './CupLabels'

/** Bar and kitchen screen. The screen is the source of truth: tickets are never lost, and labels can be reprinted from here. */
export default function Queue() {
  const { user } = useAuth()
  const { error, run } = useAction()
  const [station, setStation] = useState<'bar' | 'kitchen'>('bar')
  const [labelsFor, setLabelsFor] = useState('')
  const [reason, setReason] = useState(RUSH_REASONS[0])
  const [remaking, setRemaking] = useState('')
  const [why, setWhy] = useState(NO_REASON)
  const all = useLiveQuery(async () => {
    const open = await db.queueItems.where('status').anyOf('queued', 'making', 'ready').toArray()
    const ids = [...new Set(open.map((i) => i.orderId))]
    return db.queueItems.where('orderId').anyOf(ids).toArray() // whole orders, so "order ready" sees every station
  }, [])
  const perItem = useLiveQuery(() => getSetting('queueMinutesPerItem'), [])
  if (!all || !user || perItem === undefined) return null

  const orders = new Map<string, QueueItem[]>()
  for (const i of all) orders.set(i.orderId, [...(orders.get(i.orderId) ?? []), i])
  const cards = [...orders.values()]
    .map((items) => ({ items, here: items.filter((i) => i.station === station && i.status !== 'served' && i.status !== 'void') }))
    .filter((c) => c.here.length > 0)
    .sort((a, b) => byUrgency(a.items[0], b.items[0]))
  const est = waitEstimate(all, station, perItem)

  return (
    <section>
      <h2>Queue</h2>
      <div className="seg">
        {(['bar', 'kitchen'] as const).map((s) => (
          <button key={s} aria-pressed={station === s} onClick={() => setStation(s)}>{s === 'bar' ? 'Bar' : 'Kitchen'}</button>
        ))}
      </div>
      <p>{est.waiting === 0 ? 'Nothing waiting.' : `${est.waiting} waiting · about ${est.minutes} min`}</p>
      <Err msg={error} />
      {labelsFor && <CupLabels items={all.filter((i) => i.orderId === labelsFor && i.station === station)} onClose={() => setLabelsFor('')} />}
      {cards.map(({ items, here }) => {
        const first = items[0]
        return (
          <div key={first.orderId} className="card">
            <div className="row between">
              <strong>{first.orderNumber > 0 && `#${first.orderNumber} `}{first.orderLabel} <small>{first.orderType}</small></strong>
              {first.rush && <strong className="allergy-note">RUSH: {first.rushReason}</strong>}
              {orderReady(items) && <strong>ORDER READY</strong>}
            </div>
            {here.map((i) => {
              const next = FLOW[FLOW.indexOf(i.status) + 1]
              const canUndo = !!i.prevStatus && Date.now() - Date.parse(i.statusAt) <= UNDO_MS
              return (
                <div key={i.id} className="row between">
                  <div>
                    <strong>{i.qty}× {i.name}</strong> <small>{i.variantLabel} · {i.status}</small>
                    {i.mods.length > 0 && <div><small>{i.mods.join(', ')}</small></div>}
                    {i.notes.length > 0 && <div><small>{i.notes.join(' · ')}</small></div>}
                    {i.allergy && <div className="allergy-note">⚠ ALLERGY: {i.allergy}</div>}
                  </div>
                  <span className="row">
                    {canUndo && <button onClick={() => run(() => undoStatus(i.id, user.id))}>Undo</button>}
                    {can(user.role, 'remake') && <button onClick={() => { setWhy(NO_REASON); setRemaking(i.id) }}>Remake</button>}
                    {next && <button className="primary" onClick={() => run(() => setItemStatus(i.id, next, user.id))}>{STATUS_ACTION[next]}</button>}
                  </span>
                  {remaking === i.id && (
                    <div className="row">
                      <ReasonFields value={why} onChange={setWhy} />
                      <button className="primary" onClick={async () => { if (await run(() => remakeItem(i.id, user.id, why.code, why.note))) setRemaking('') }}>Make again</button>
                      <button onClick={() => setRemaking('')}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="row">
              <button onClick={() => setLabelsFor(first.orderId)}>Labels</button>
              {!first.rush && (
                <>
                  <select aria-label="Rush reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {RUSH_REASONS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <button onClick={() => run(() => setRush(first.orderId, reason, user.id))}>Rush</button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}
