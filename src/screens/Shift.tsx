import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Denoms, type Shift as ShiftRow } from '../db/db'
import {
  DENOMS, closeBusinessDay, countTotal, expectedFloat, getOpenDay, getOpenShift, lateCloseShift, openBusinessDay, openShift,
} from '../db/shifts'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { can } from '../lib/roles'
import { formatPeso } from '../lib/money'
import { Err, useAction } from '../ui'


const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

export default function Shift() {
  const terminals = useLiveQuery(() => db.terminals.toArray().then((t) => t.filter((x) => x.active)), [])
  const [stored, setStored] = useState(() => localStorage.getItem(DEVICE_KEY) ?? '')
  if (!terminals) return null
  if (terminals.length === 0) return <p>No terminal yet. The owner adds one in Setup.</p>

  const terminal = resolveTerminal(terminals, stored)!
  const pick = (id: string) => {
    localStorage.setItem(DEVICE_KEY, id)
    setStored(id)
  }

  return (
    <>
      <h2>Shift</h2>
      <p>
        <label>
          This device is{' '}
          <select value={terminal.id} onChange={(e) => pick(e.target.value)}>
            {terminals.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.invoicePrefix})</option>)}
          </select>
        </label>
      </p>
      <Day branchId={terminal.branchId} />
      <ShiftPanel terminalId={terminal.id} branchId={terminal.branchId} />
    </>
  )
}

function Day({ branchId }: { branchId: string }) {
  const { user } = useAuth()
  const day = useLiveQuery(async () => ({ d: await getOpenDay(branchId) }), [branchId])
  const { error, run } = useAction()
  if (!day || !user) return null
  const canOpen = can(user.role, 'openDay')

  return (
    <section className="card">
      <h3>Business day</h3>
      {day.d ? (
        <>
          <p>Open for <strong>{day.d.date}</strong>, started {when(day.d.openedAt)}.</p>
          {canOpen && <button onClick={() => run(() => closeBusinessDay(day.d!.id, user.id))}>Close business day</button>}
        </>
      ) : (
        <>
          <p>No business day is open. Nobody can sell until a supervisor opens one.</p>
          {canOpen ? <button onClick={() => run(() => openBusinessDay(branchId, user.id))}>Open business day</button> : <p>Ask a supervisor.</p>}
        </>
      )}
      <Err msg={error} />
    </section>
  )
}

function ShiftPanel({ terminalId, branchId }: { terminalId: string; branchId: string }) {
  const { user } = useAuth()
  const state = useLiveQuery(
    async () => ({ day: await getOpenDay(branchId), shift: await getOpenShift(terminalId) }),
    [terminalId, branchId],
  )
  if (!state || !user) return null
  if (state.shift) return <OpenShift shift={state.shift} terminalId={terminalId} />
  if (!state.day) return <section className="card"><h3>Shift</h3><p>Open the business day first.</p></section>
  if (!can(user.role, 'openShift')) return <section className="card"><h3>Shift</h3><p>Your role can't open a shift.</p></section>
  return <OpenShiftForm terminalId={terminalId} />
}

function OpenShift({ shift, terminalId }: { shift: ShiftRow; terminalId: string }) {
  const { user } = useAuth()
  const cashier = useLiveQuery(() => db.users.get(shift.cashierId), [shift.cashierId])
  const [reason, setReason] = useState('')
  const { error, run } = useAction()
  const mine = shift.cashierId === user?.id
  return (
    <section className="card">
      <h3>Shift open</h3>
      <p>
        {mine ? 'You' : cashier?.name ?? '…'} opened it {when(shift.openedAt)} with {formatPeso(shift.openingTotal)}.
        {shift.floatGap !== 0 && <> <strong>Float gap: {formatPeso(shift.floatGap)}</strong> against {formatPeso(shift.expectedFloat)}.</>}
      </p>
      <p>Selling and the shift close arrive in the next parts.</p>
      {user && can(user.role, 'openDay') && (
        <form
          className="row"
          onSubmit={(e) => { e.preventDefault(); run(() => lateCloseShift(shift.id, user.id, reason)) }}
        >
          <input aria-label="Reason" placeholder="Why close it late?" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button disabled={!reason.trim()}>Late close this shift</button>
        </form>
      )}
      <Err msg={error} />
      <small>Terminal {terminalId.slice(0, 4)}</small>
    </section>
  )
}

function OpenShiftForm({ terminalId }: { terminalId: string }) {
  const { user } = useAuth()
  const [counts, setCounts] = useState<Denoms>({})
  const expected = useLiveQuery(() => expectedFloat(terminalId), [terminalId])
  const { error, run } = useAction()
  if (!user || !expected) return null

  const total = countTotal(counts)
  const gap = total - expected.amount
  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(() => openShift(terminalId, user.id, counts))
  }

  return (
    <form onSubmit={submit} className="card">
      <h3>Open your shift: count the drawer</h3>
      <div className="denoms">
        {DENOMS.map((d) => (
          <label key={d.key}>
            {d.label}
            <input
              inputMode="numeric"
              placeholder="0"
              value={counts[d.key] ?? ''}
              onChange={(e) => setCounts({ ...counts, [d.key]: Number(e.target.value.replace(/\D/g, '').slice(0, 4)) || 0 })}
            />
          </label>
        ))}
      </div>
      <table className="compare">
        <tbody>
          <tr><th>Expected ({expected.source === 'last-close' ? 'left by last closer' : 'float setting'})</th><td>{formatPeso(expected.amount)}</td></tr>
          <tr><th>You counted</th><td>{formatPeso(total)}</td></tr>
          <tr className={gap === 0 ? '' : 'flag'}><th>Difference</th><td>{formatPeso(gap)}</td></tr>
        </tbody>
      </table>
      {gap !== 0 && total > 0 && <p role="status">The count doesn't match. You can still open; the gap is recorded for the supervisor.</p>}
      <Err msg={error} />
      <button disabled={total === 0}>Open shift</button>
    </form>
  )
}
