import { db, type BusinessDay, type Denoms, type Shift } from './db'
import { newId } from '../lib/id'
import { audit } from './audit'
import { businessDate } from './businessDate'
import { getSetting } from './settings'
import { cashEffect, overShortStatus } from '../lib/cash'

// Philippine bills and coins. Keys keep the ₱20 bill and ₱20 coin apart. Values are centavos.
export const DENOMS = [
  { key: 'b1000', label: '₱1,000 bill', value: 100000 },
  { key: 'b500', label: '₱500 bill', value: 50000 },
  { key: 'b200', label: '₱200 bill', value: 20000 },
  { key: 'b100', label: '₱100 bill', value: 10000 },
  { key: 'b50', label: '₱50 bill', value: 5000 },
  { key: 'b20', label: '₱20 bill', value: 2000 },
  { key: 'c20', label: '₱20 coin', value: 2000 },
  { key: 'c10', label: '₱10 coin', value: 1000 },
  { key: 'c5', label: '₱5 coin', value: 500 },
  { key: 'c1', label: '₱1 coin', value: 100 },
  { key: 'c025', label: '25¢ coin', value: 25 },
] as const

export function countTotal(denoms: Denoms): number {
  return DENOMS.reduce((sum, d) => sum + (denoms[d.key] ?? 0) * d.value, 0)
}

const TABLES = [db.businessDays, db.shifts, db.cashCounts, db.terminals, db.branches, db.settings, db.auditLog, db.outbox]

export const getOpenDay = async (branchId: string): Promise<BusinessDay | undefined> =>
  (await db.businessDays.where('branchId').equals(branchId).toArray()).find((d) => !d.closedAt)

export const getOpenShift = async (terminalId: string): Promise<Shift | undefined> =>
  (await db.shifts.where('terminalId').equals(terminalId).toArray()).find((s) => !s.closedAt)

/** Selling needs an open business day and an open shift on this terminal. Used by the order screen (1E). */
export async function getSellContext(terminalId: string) {
  const terminal = await db.terminals.get(terminalId)
  if (!terminal) return null
  const [day, shift] = await Promise.all([getOpenDay(terminal.branchId), getOpenShift(terminalId)])
  return day && shift && shift.businessDayId === day.id ? { day, shift, terminal } : null
}

export async function openBusinessDay(branchId: string, userId: string): Promise<BusinessDay> {
  return db.transaction('rw', TABLES, async () => {
    const branch = await db.branches.get(branchId)
    if (!branch?.active) throw new Error('Pick an active branch')
    if (await getOpenDay(branchId)) throw new Error('This branch already has an open business day')
    const now = new Date()
    const day: BusinessDay = {
      id: newId(),
      branchId,
      date: businessDate(now, await getSetting('dayCutoffHour')),
      openedBy: userId,
      openedAt: now.toISOString(),
    }
    await db.businessDays.add(day)
    await audit({ userId, action: 'day.open', ref: day.id, detail: { date: day.date, branchId } })
    return day
  })
}

export async function closeBusinessDay(dayId: string, userId: string) {
  return db.transaction('rw', TABLES, async () => {
    const day = await db.businessDays.get(dayId)
    if (!day || day.closedAt) throw new Error('No open day to close')
    const terminals = await db.terminals.where('branchId').equals(day.branchId).toArray()
    for (const t of terminals) {
      if (await getOpenShift(t.id)) throw new Error(`Close the open shift on ${t.name} first`)
    }
    // ponytail: only checks shifts. The full checklist (tabs, held carts, pending GCash) lands in 2E.
    await db.businessDays.update(dayId, { closedAt: new Date().toISOString(), closedBy: userId })
    await audit({ userId, action: 'day.close', ref: dayId })
  })
}

/** What the drawer should start with: what the last closer left, else the float setting. */
export async function expectedFloat(terminalId: string): Promise<{ amount: number; source: 'last-close' | 'setting' }> {
  const last = (await db.shifts.where('terminalId').equals(terminalId).toArray())
    .filter((s) => s.closedAt)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]
  if (last?.leftInDrawer !== undefined) return { amount: last.leftInDrawer, source: 'last-close' }
  return { amount: await getSetting('floatCentavos'), source: 'setting' }
}

/** A gap against the expected float is flagged and recorded, never blocked (rule 1). */
export async function openShift(terminalId: string, cashierId: string, denoms: Denoms): Promise<Shift> {
  return db.transaction('rw', TABLES, async () => {
    const terminal = await db.terminals.get(terminalId)
    if (!terminal?.active) throw new Error('Pick an active terminal')
    const day = await getOpenDay(terminal.branchId)
    if (!day) throw new Error('A supervisor must open the business day first')
    const prior = await getOpenShift(terminalId)
    if (prior) {
      throw new Error(
        prior.cashierId === cashierId
          ? 'You already have a shift open on this terminal'
          : 'The previous shift on this terminal is still open. A supervisor must close it first.',
      )
    }
    const total = countTotal(denoms)
    const expected = (await expectedFloat(terminalId)).amount
    const now = new Date().toISOString()
    const shift: Shift = {
      id: newId(),
      terminalId,
      businessDayId: day.id,
      cashierId,
      openedAt: now,
      openingTotal: total,
      expectedFloat: expected,
      floatGap: total - expected,
    }
    await db.shifts.add(shift)
    await db.cashCounts.add({ id: newId(), shiftId: shift.id, kind: 'open', countedBy: cashierId, at: now, denoms, total })
    await audit({
      userId: cashierId,
      action: 'shift.open',
      ref: shift.id,
      detail: { terminalId, total, expected, gap: shift.floatGap },
    })
    return shift
  })
}

/** Supervisor closes a shift nobody closed. No count; marked "late close". Normal close is 1K. */
export async function lateCloseShift(shiftId: string, supervisorId: string, reason: string) {
  return db.transaction('rw', TABLES, async () => {
    const s = await db.shifts.get(shiftId)
    if (!s || s.closedAt) throw new Error('Shift is not open')
    if (!reason.trim()) throw new Error('A reason is required')
    await db.shifts.update(shiftId, {
      closedAt: new Date().toISOString(),
      closedBy: supervisorId,
      lateClose: true,
      lateCloseReason: reason.trim(),
    })
    await audit({ userId: supervisorId, action: 'shift.lateClose', ref: shiftId, detail: { reason: reason.trim() } })
  })
}

/**
 * Cash that should be in the drawer: the opening count plus cash taken for sales (the part applied to orders, not the change given back),
 * minus cash handed back in refunds and voids during this shift (a refund for an old sale comes out of today's drawer),
 * plus paid-ins, minus paid-outs and drops to the safe.
 */
export async function expectedCash(shiftId: string): Promise<number> {
  const shift = await db.shifts.get(shiftId)
  if (!shift) throw new Error('Shift not found')
  const orderIds = (await db.orders.where('shiftId').equals(shiftId).toArray()).map((o) => o.id)
  const cash = (await db.payments.where('orderId').anyOf(orderIds).toArray()).filter((p) => p.method === 'cash')
  const refunded = (await db.refunds.where('shiftId').equals(shiftId).toArray()).reduce((s, r) => s + r.cashAmount, 0)
  const moved = (await db.cashMovements.where('shiftId').equals(shiftId).toArray()).reduce((s, m) => s + cashEffect(m.kind, m.amount), 0)
  return shift.openingTotal + cash.reduce((s, p) => s + p.amount, 0) - refunded + moved
}

/**
 * Step 1 of closing: the blind count. Saves the count by denomination and does not close anything.
 * The cashier gets one recount; both counts stay in the log. The screen shows expected only after this call.
 */
export async function submitCloseCount(shiftId: string, userId: string, denoms: Denoms) {
  return db.transaction('rw', db.shifts, db.cashCounts, db.orders, db.payments, async () => {
    const shift = await db.shifts.get(shiftId)
    if (!shift || shift.closedAt) throw new Error('Shift is not open')
    if (shift.cashierId !== userId) throw new Error("Only the cashier who opened this shift can close it. A supervisor can late-close it.")
    const total = countTotal(denoms)
    if (total === 0) throw new Error('Count the drawer first')
    const attempt = (await db.cashCounts.where('shiftId').equals(shiftId).filter((c) => c.kind === 'close').count()) + 1
    if (attempt > 2) throw new Error('One recount only. Close the shift with the second count.')
    await db.cashCounts.add({ id: newId(), shiftId, kind: 'close', attempt, countedBy: userId, at: new Date().toISOString(), denoms, total })
  })
}

/** Where the closing stands: the latest count against what the system expects. Null until a count is submitted. */
export async function getCloseSummary(shiftId: string) {
  const shift = await db.shifts.get(shiftId)
  if (!shift) return null
  const counts = (await db.cashCounts.where('shiftId').equals(shiftId).filter((c) => c.kind === 'close').toArray()).sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0))
  const last = counts[counts.length - 1]
  if (!last) return null
  const expected = await expectedCash(shiftId)
  const tolerance = await getSetting('overShortToleranceCentavos')
  const orderIds = (await db.orders.where('shiftId').equals(shiftId).toArray()).map((o) => o.id)
  return {
    attempts: counts.length,
    counts: counts.map((c) => c.total),
    counted: last.total,
    expected,
    tolerance,
    ...overShortStatus(last.total, expected, tolerance),
    // Flagged for the closer, never blocking (day close is where open items block, 2E).
    heldCarts: (await db.heldCarts.where('shiftId').equals(shiftId).toArray()).filter((h) => h.status === 'held').length,
    pendingPayments: (await db.payments.where('orderId').anyOf(orderIds).toArray()).filter((p) => p.status === 'pending').length,
  }
}

/** Step 2 of closing: uses the latest count. Past the tolerance a note is required. The drawer total is left for the next opener. */
export async function closeShift(shiftId: string, userId: string, note = '') {
  const sum = await getCloseSummary(shiftId)
  if (!sum) throw new Error('Count the drawer before closing')
  if (!sum.within && !note.trim()) throw new Error(`The drawer is ${sum.diff < 0 ? 'short' : 'over'} past the tolerance. Add a note to close.`)
  return db.transaction('rw', db.shifts, db.auditLog, db.outbox, db.settings, async () => {
    const shift = await db.shifts.get(shiftId)
    if (!shift || shift.closedAt) throw new Error('Shift is not open')
    if (shift.cashierId !== userId) throw new Error('Only the cashier who opened this shift can close it. A supervisor can late-close it.')
    await db.shifts.update(shiftId, {
      closedAt: new Date().toISOString(),
      closedBy: userId,
      expectedCash: sum.expected,
      closeCounted: sum.counted,
      overShort: sum.diff,
      ...(note.trim() && { overShortNote: note.trim() }),
      leftInDrawer: sum.counted,
    })
    await audit({
      userId,
      action: 'shift.close',
      ref: shiftId,
      detail: { expected: sum.expected, counted: sum.counted, overShort: sum.diff, counts: sum.counts, note: note.trim() || undefined, heldCarts: sum.heldCarts, pendingPayments: sum.pendingPayments },
    })
    return sum
  })
}
