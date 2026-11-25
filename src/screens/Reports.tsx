import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { getZReport, loadReport, runXReport, seniorPwdLog } from '../db/reports'
import { can } from '../lib/roles'
import { formatPeso } from '../lib/money'
import { Err, useAction } from '../ui'
import ReportView from './ReportView'

type Mode = 'dashboard' | 'x' | 'z'
const when = (iso: string) => new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

export default function Reports() {
  const { user } = useAuth()
  const [mode, setMode] = useState<Mode>(user && can(user.role, 'viewAllBranches') ? 'dashboard' : 'x')
  if (!user) return null
  return (
    <section>
      <h2>Reports</h2>
      <div className="seg">
        {can(user.role, 'viewAllBranches') && <button aria-pressed={mode === 'dashboard'} onClick={() => setMode('dashboard')}>Owner dashboard</button>}
        <button aria-pressed={mode === 'x'} onClick={() => setMode('x')}>X: this shift</button>
        <button aria-pressed={mode === 'z'} onClick={() => setMode('z')}>Z: closed days</button>
      </div>
      {mode === 'dashboard' && <Dashboard />}
      {mode === 'x' && <XReport userId={user.id} />}
      {mode === 'z' && <ZReports userId={user.id} />}
    </section>
  )
}

const Tile = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className={`card ${warn ? 'flag' : ''}`} style={{ minWidth: '12rem' }}>
    <small>{label}</small>
    <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div>
  </div>
)

/** The three numbers checked every night (net sales, cash over/short, voids + refunds), then the rest. */
function Dashboard() {
  const dates = useLiveQuery(async () => [...new Set((await db.businessDays.toArray()).map((d) => d.date))].sort().reverse(), [])
  const [picked, setPicked] = useState('')
  const date = picked || dates?.[0] || ''
  const data = useLiveQuery(async () => (date ? { report: await loadReport({ kind: 'date', date }), log: await seniorPwdLog(date) } : null), [date])
  if (!dates) return null
  if (dates.length === 0) return <p className="empty">No business day has been opened yet.</p>
  const r = data?.report
  const off = r?.shifts.filter((s) => s.closed && (s.overShort ?? 0) !== 0) ?? []
  return (
    <>
      <label>Business date{' '}
        <select value={date} onChange={(e) => setPicked(e.target.value)}>{dates.map((d) => <option key={d}>{d}</option>)}</select>
      </label>
      {r && (
        <>
          <div className="row">
            <Tile label="Net sales" value={formatPeso(r.net)} />
            <Tile label="Voids + refunds" value={`${formatPeso(r.voids.amount + r.refunds.amount)} (${r.voids.count + r.refunds.count})`} />
            <Tile label="Comps (value)" value={`${formatPeso(r.comps.value)} (${r.comps.count})`} />
            <Tile label="No-sale opens" value={String(r.noSales)} warn={r.noSales > 0} />
          </div>
          <div className="card">
            <h4>Cash over/short, shift by shift</h4>
            {off.length === 0 ? <p>No closed shift is over or short.</p> : (
              <ul className="lines">{off.map((s) => <li key={s.shiftId}>{(s.overShort ?? 0) > 0 ? 'Over' : 'Short'} {formatPeso(Math.abs(s.overShort ?? 0))}{s.note && ` · ${s.note}`}</li>)}</ul>
            )}
          </div>
          <ReportView title={`Business day ${date}`} report={r} onPrint />
          <div className="card">
            <h4>Senior/PWD discount log</h4>
            {data.log.length === 0 && <p className="empty">None this day.</p>}
            <ul className="lines">
              {data.log.map((l) => (
                <li key={l.id} className="row between">
                  <span>{l.kind === 'senior' ? 'Senior' : 'PWD'} {l.name} · ID {l.idNumber} {l.repeatId && <strong>· REPEAT ID TODAY</strong>} <small>{l.items} · VAT-exempt {formatPeso(l.vatExempt)}</small></span>
                  <strong>−{formatPeso(l.reduction)}</strong>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  )
}

/** X report: the shift as it stands. Reading it changes nothing (it is logged). */
function XReport({ userId }: { userId: string }) {
  const shifts = useLiveQuery(async () => {
    const all = (await db.shifts.toArray()).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 20)
    const terminals = new Map((await db.terminals.toArray()).map((t) => [t.id, t.name]))
    const users = new Map((await db.users.toArray()).map((u) => [u.id, u.name]))
    return all.map((s) => ({ ...s, label: `${terminals.get(s.terminalId)} · ${users.get(s.cashierId)} · ${when(s.openedAt)}${s.closedAt ? '' : ' (open)'}` }))
  }, [])
  const [id, setId] = useState('')
  const [report, setReport] = useState<Awaited<ReturnType<typeof runXReport>> | null>(null)
  const { error, run } = useAction()
  if (!shifts) return null
  if (shifts.length === 0) return <p className="empty">No shifts yet.</p>
  const chosen = id || shifts[0].id
  return (
    <>
      <div className="row">
        <select aria-label="Shift" value={chosen} onChange={(e) => { setId(e.target.value); setReport(null) }}>{shifts.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        <button className="primary" onClick={() => run(async () => setReport(await runXReport(chosen, userId)))}>Run X report</button>
      </div>
      <Err msg={error} />
      {report && <ReportView title={`X report: ${shifts.find((s) => s.id === chosen)?.label}`} report={report} onPrint />}
    </>
  )
}

/** Z reports are frozen at day close. */
function ZReports({ userId }: { userId: string }) {
  const days = useLiveQuery(async () => (await db.businessDays.toArray()).filter((d) => d.closedAt).sort((a, b) => b.date.localeCompare(a.date)), [])
  const [dayId, setDayId] = useState('')
  const z = useLiveQuery(async () => (dayId ? getZReport(dayId, userId) : null), [dayId])
  if (!days) return null
  if (days.length === 0) return <p className="empty">No day has been closed yet.</p>
  return (
    <>
      <select aria-label="Closed day" value={dayId} onChange={(e) => setDayId(e.target.value)}>
        <option value="">Pick a closed day</option>
        {days.map((d) => <option key={d.id} value={d.id}>{d.date}</option>)}
      </select>
      {z && <ReportView title={`Z report ${z.date}, closed ${when(z.at)}`} report={z.report} onPrint />}
    </>
  )
}
