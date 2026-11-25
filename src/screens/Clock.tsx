import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type TimeEntry } from '../db/db'
import { clockIn, clockOut, entriesBetween, fixEntry, openEntry } from '../db/timeclock'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { getSetting } from '../db/settings'
import { can } from '../lib/roles'
import { entryHours, hoursCsv, isLong } from '../lib/timeclock'
import { ymdLocal } from '../lib/promos'
import { Err, useAction } from '../ui'

const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
const toLocalInput = (iso: string) => new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

export default function Clock() {
  const { user } = useAuth()
  const terminals = useLiveQuery(() => db.terminals.toArray().then((t) => t.filter((x) => x.active)), [])
  const mine = useLiveQuery(async () => ({ e: user ? await openEntry(user.id) : undefined }), [user?.id])
  const { error, run } = useAction()
  if (!user || !terminals || !mine) return null
  const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  return (
    <section>
      <h2>Clock in / out</h2>
      <div className="card">
        {mine.e ? <p>You clocked in {when(mine.e.inAt)}.</p> : <p>You are not clocked in.</p>}
        {!terminal && <p>This device is not set up as a store terminal yet.</p>}
        <Err msg={error} />
        {mine.e
          ? <button className="primary" onClick={() => run(() => clockOut(user.id))}>Clock out</button>
          : <button className="primary" disabled={!terminal} onClick={() => run(() => clockIn(user.id, terminal!.id))}>Clock in</button>}
      </div>
      {can(user.role, 'fixTime') && <Team userId={user.id} />}
    </section>
  )
}

/** Supervisor view: everyone's hours, long shifts flagged, fix with a reason, export for payroll. */
function Team({ userId }: { userId: string }) {
  const today = ymdLocal(new Date())
  const [from, setFrom] = useState(ymdLocal(new Date(Date.now() - 14 * 86_400_000)))
  const [to, setTo] = useState(today)
  const [fixing, setFixing] = useState<TimeEntry | null>(null)
  const data = useLiveQuery(async () => ({
    entries: await entriesBetween(from, to),
    names: new Map((await db.users.toArray()).map((u) => [u.id, u.name])),
    limit: await getSetting('longShiftHours'),
  }), [from, to])
  const { error, run } = useAction()
  if (!data) return null
  const now = new Date()
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([hoursCsv(data.entries, data.names, now, data.limit)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `hours-${from}-to-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="card">
      <h3>Team hours</h3>
      <div className="row">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={exportCsv} disabled={data.entries.length === 0}>Export hours (CSV)</button>
      </div>
      <Err msg={error} />
      {fixing && <FixForm entry={fixing} onCancel={() => setFixing(null)} onSave={(f, reason) => run(() => fixEntry(fixing.id, f, reason, userId)).then((ok) => ok && setFixing(null))} />}
      {data.entries.length === 0 && <p className="empty">No clock-ins in this range.</p>}
      <ul className="lines">
        {[...data.entries].reverse().map((e) => {
          const long = isLong(e, now, data.limit)
          return (
            <li key={e.id} className="row between">
              <span>
                <strong>{data.names.get(e.userId)}</strong> {e.businessDate} · {when(e.inAt)} → {e.outAt ? when(e.outAt) : 'still clocked in'} · {entryHours(e)} h
                {long && <strong> · LONG SHIFT</strong>}{e.edits?.length ? <small> · fixed: {e.edits[e.edits.length - 1].reason}</small> : null}
              </span>
              {e.userId !== userId && <button onClick={() => setFixing(e)}>Fix</button>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function FixForm({ entry, onSave, onCancel }: { entry: TimeEntry; onSave: (f: { inAt: string; outAt: string }, reason: string) => void; onCancel: () => void }) {
  const [inAt, setIn] = useState(toLocalInput(entry.inAt))
  const [outAt, setOut] = useState(entry.outAt ? toLocalInput(entry.outAt) : '')
  const [reason, setReason] = useState('')
  const iso = (v: string) => (v ? new Date(v).toISOString() : '')
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); onSave({ inAt: iso(inAt), outAt: iso(outAt) }, reason) }}>
      <label>In <input type="datetime-local" value={inAt} onChange={(e) => setIn(e.target.value)} /></label>
      <label>Out <input type="datetime-local" value={outAt} onChange={(e) => setOut(e.target.value)} /></label>
      <input aria-label="Reason" placeholder="Why? (e.g. forgot to clock out)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={!reason.trim() || !outAt}>Save fix</button>
    </form>
  )
}
