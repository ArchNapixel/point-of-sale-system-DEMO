import { db, type Approval } from './db'
import { newId } from '../lib/id'
import { canApprove, needsApproval, type ApprovalAction, type Limits } from '../lib/approval'
import { audit } from './audit'
import { businessDate } from './businessDate'
import { getSetting } from './settings'
import { verifyLogin } from './users'

const MAX_AGE_MS = 10 * 60_000 // an approval must be used within 10 minutes

export async function getLimits(): Promise<Limits> {
  return { discountCashier: await getSetting('cashierDiscountLimitCentavos'), discountSupervisor: await getSetting('supervisorDiscountLimitCentavos') }
}

/**
 * Checks the approver's personal PIN and records the approval (by who, on which terminal, when).
 * A wrong PIN is logged and refused. Approving your own action is allowed but flagged.
 * ponytail: no lockout after repeated wrong PINs; add a counter per approver if PIN guessing becomes a worry.
 */
export async function approve(i: {
  action: ApprovalAction; requesterId: string; approverId: string; pin: string; terminalId: string; amount?: number; ref?: string
}): Promise<Approval> {
  const amount = i.amount ?? 0
  const approver = await verifyLogin(i.approverId, i.pin)
  if (!approver) {
    await audit({ userId: i.requesterId, action: 'approval.failed', detail: { approverId: i.approverId, terminalId: i.terminalId, for: i.action } })
    throw new Error('Wrong PIN')
  }
  if (!canApprove(approver.role, i.action, amount, await getLimits())) throw new Error(`${approver.name} cannot approve this. Ask someone with more authority.`)
  const now = new Date()
  const a: Approval = {
    id: newId(), action: i.action, requesterId: i.requesterId, approverId: approver.id, terminalId: i.terminalId, at: now.toISOString(),
    businessDate: businessDate(now, await getSetting('dayCutoffHour')), amount, ...(i.ref && { ref: i.ref }), selfApproved: i.requesterId === approver.id,
  }
  await db.approvals.add(a)
  await db.outbox.add({ id: newId(), table: 'approvals', recordId: a.id, at: a.at, synced: 0 })
  await audit({ userId: i.requesterId, approverId: approver.id, action: `approval.${i.action}`, ref: i.ref, detail: { amount, terminalId: i.terminalId, selfApproved: a.selfApproved } })
  return a
}

/**
 * The data-layer gate: does this actor need approval for this action, and if so is the given approval valid and unused?
 * Marks it used (call inside the action's transaction on db.approvals). Returns the approver id, or undefined when none was needed.
 */
export async function consumeApproval(
  actorId: string, action: ApprovalAction, amount: number, usedFor: string, approvalId?: string, ref?: string,
): Promise<string | undefined> {
  if (action === 'discount' && amount === 0) return undefined // no discount on the order
  const actor = await db.users.get(actorId)
  if (!actor) throw new Error('Unknown user')
  if (!needsApproval(actor.role, action, amount, await getLimits())) return undefined
  const a = approvalId ? await db.approvals.get(approvalId) : undefined
  const ok = a && a.action === action && a.requesterId === actorId && !a.usedFor && a.amount >= amount && Date.now() - Date.parse(a.at) <= MAX_AGE_MS && (!ref || a.ref === ref)
  if (!a || !ok) throw new Error('This needs a supervisor PIN')
  await db.approvals.update(a.id, { usedFor })
  return a.approverId
}
