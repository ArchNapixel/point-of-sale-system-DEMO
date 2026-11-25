import { db, type CashMovement } from './db'
import { newId } from '../lib/id'
import { CASH_KINDS, type CashKind } from '../lib/cash'
import { audit } from './audit'
import { consumeApproval } from './approvals'
import { expectedCash } from './shifts'

/**
 * Records cash moving in or out of the drawer without a sale. Always needs a reason and a supervisor PIN.
 * Only the cashier who owns the drawer can record it (a supervisor approves, they do not run it for them).
 * Money out cannot be more than the drawer should hold: a bigger amount is a typo, not a cash drop.
 * The same key never records twice (a double tap). Expected cash at close includes every movement (see expectedCash).
 */
export async function recordCash(i: {
  shiftId: string; userId: string; kind: CashKind; amount: number; reason: string; receiptRef?: string; approvalId?: string; idempotencyKey: string
}): Promise<CashMovement> {
  const prior = await db.cashMovements.where('idempotencyKey').equals(i.idempotencyKey).first()
  if (prior) return prior
  const kind = CASH_KINDS.find((k) => k.id === i.kind)
  if (!kind) throw new Error('Pick what kind of cash movement this is')
  if (!i.reason.trim()) throw new Error('A reason is required')
  if (i.kind === 'no-sale' ? i.amount !== 0 : !Number.isInteger(i.amount) || i.amount <= 0) throw new Error(i.kind === 'no-sale' ? 'A no-sale open moves no money' : 'Enter the amount')
  const row = await db.transaction('rw', [db.shifts, db.cashMovements, db.orders, db.payments, db.refunds, db.approvals, db.users, db.settings, db.outbox, db.businessDays, db.deposits, db.giftCardTx, db.accountTx], async () => {
    const shift = await db.shifts.get(i.shiftId)
    if (!shift || shift.closedAt) throw new Error('Shift is not open')
    if (shift.cashierId !== i.userId) throw new Error('Only the cashier who owns this drawer can record cash movements')
    if (kind.sign < 0 && i.amount > (await expectedCash(i.shiftId))) throw new Error('That is more than the drawer should hold. Check the amount.')
    const day = (await db.businessDays.get(shift.businessDayId))!
    const id = newId()
    const approvedBy = await consumeApproval(i.userId, 'cash', i.amount, id, i.approvalId, i.shiftId)
    if (!approvedBy) throw new Error('This needs a supervisor PIN')
    const m: CashMovement = {
      id, shiftId: shift.id, terminalId: shift.terminalId, kind: i.kind, amount: i.amount, reason: i.reason.trim(),
      ...(i.receiptRef?.trim() && { receiptRef: i.receiptRef.trim() }), userId: i.userId, approvedBy, businessDate: day.date, at: new Date().toISOString(), idempotencyKey: i.idempotencyKey,
    }
    await db.cashMovements.add(m)
    await db.outbox.add({ id: newId(), table: 'cashMovements', recordId: m.id, at: m.at, synced: 0 })
    return m
  })
  await audit({
    userId: i.userId, approverId: row.approvedBy, action: `cash.${row.kind}`, ref: row.shiftId,
    detail: { amount: row.amount, reason: row.reason, receiptRef: row.receiptRef, selfApproved: row.approvedBy === row.userId },
  })
  return row
}
