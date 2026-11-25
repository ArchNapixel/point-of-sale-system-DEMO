import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Approval } from '../db/db'
import { approve, getLimits } from '../db/approvals'
import { listActiveUsers } from '../db/users'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { canApprove, type ApprovalAction } from '../lib/approval'
import { Err, useAction } from '../ui'

/** Asks for a supervisor's (or owner's) own PIN. Pick your name, not a shared PIN: every approval is logged by person, terminal and time. */
export default function ApprovalPrompt({ action, amount, requesterId, orderRef, title, onApproved, onCancel }: {
  action: ApprovalAction; amount: number; requesterId: string; orderRef?: string; title: string
  onApproved: (a: Approval) => void; onCancel: () => void
}) {
  const users = useLiveQuery(listActiveUsers, [])
  const limits = useLiveQuery(getLimits, [])
  const terminals = useLiveQuery(() => db.terminals.toArray().then((t) => t.filter((x) => x.active)), [])
  const [approverId, setApproverId] = useState('')
  const [pin, setPin] = useState('')
  const { error, run } = useAction()
  if (!users || !limits || !terminals) return null
  const eligible = users.filter((u) => canApprove(u.role, action, amount, limits))
  const chosen = approverId || eligible[0]?.id || ''
  const terminal = resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        run(async () => {
          if (!terminal) throw new Error('This device has no terminal yet')
          onApproved(await approve({ action, requesterId, approverId: chosen, pin, terminalId: terminal.id, amount, ref: orderRef }))
        })
      }}
    >
      <h4>{title}</h4>
      {eligible.length === 0 ? (
        <p>Nobody on staff can approve this. The owner adds a supervisor in Setup.</p>
      ) : (
        <>
          <label>Approved by{' '}
            <select value={chosen} onChange={(e) => setApproverId(e.target.value)}>
              {eligible.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          </label>
          <input aria-label="Approver PIN" type="password" inputMode="numeric" placeholder="Their personal PIN" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} />
        </>
      )}
      <Err msg={error} />
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!chosen || !pin}>Approve</button>
      </div>
    </form>
  )
}
