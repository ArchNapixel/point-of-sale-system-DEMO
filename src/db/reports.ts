import { db, type ZReport } from './db'
import { newId } from '../lib/id'
import { buildReport, type Report } from '../lib/reports'
import { audit } from './audit'
import { closeBusinessDay, expectedCash } from './shifts'

/** X = one shift, live. Day = one business day of one branch (Z when closed). Date = every branch on a business date (owner dashboard). */
export type Scope = { kind: 'shift'; shiftId: string } | { kind: 'day'; dayId: string } | { kind: 'date'; date: string }

async function shiftsFor(scope: Scope) {
  if (scope.kind === 'shift') return [await db.shifts.get(scope.shiftId)].filter((s) => !!s)
  const days = scope.kind === 'day' ? [await db.businessDays.get(scope.dayId)].filter((d) => !!d) : await db.businessDays.where('date').equals(scope.date).toArray()
  return (await db.shifts.where('businessDayId').anyOf(days.map((d) => d.id)).toArray())
}

export async function loadReport(scope: Scope): Promise<Report> {
  const shifts = await shiftsFor(scope)
  const ids = shifts.map((s) => s.id)
  const orders = await db.orders.where('shiftId').anyOf(ids).toArray()
  const refunds = await db.refunds.where('shiftId').anyOf(ids).toArray() // a refund comes out of the drawer where it is given
  const moves = await db.cashMovements.where('shiftId').anyOf(ids).toArray()
  const payments = await db.payments.where('orderId').anyOf(orders.map((o) => o.id)).toArray()
  const refundedPayments = await db.payments.where('orderId').anyOf([...new Set(refunds.map((r) => r.orderId))]).toArray()
  const withExpected = await Promise.all(shifts.map(async (s) => ({ ...s, expectedCash: await expectedCash(s.id) })))
  const walkouts = (await db.tabs.where('status').equals('walkout').toArray()).filter((t) => t.walkout && ids.includes(t.walkout.shiftId))
  const allDeposits = await db.deposits.toArray()
  const deposits = allDeposits.filter((d) => ids.includes(d.shiftId))
  const heldDeposits = allDeposits.filter((d) => d.status === 'held')
  const channelNames = new Map((await db.channels.toArray()).map((c) => [c.id, c.name]))
  return buildReport({ orders, payments, refunds, moves, shifts: withExpected, refundedPayments, walkouts, deposits, heldDeposits, channelNames })
}

/** The Senior/PWD discount log for a scope, newest first (the owner's tax-claim record). */
export async function seniorPwdLog(date: string) {
  return (await db.discountLog.where('businessDate').equals(date).toArray()).sort((a, b) => b.at.localeCompare(a.at))
}

/** Closes the day (blocked while the checklist has anything open) and freezes the Z report as it stood at close. */
export async function closeDayAndReport(dayId: string, userId: string): Promise<ZReport> {
  await closeBusinessDay(dayId, userId)
  return getZReport(dayId, userId)
}

/**
 * The saved Z report for a closed day. Made once, at close; never rewritten. If a crash stopped it being saved, it is built now.
 * ponytail: late offline sales that sync after close are not flagged as "changed after close" yet (needs sync, 4x).
 */
export async function getZReport(dayId: string, userId: string): Promise<ZReport> {
  const saved = await db.zReports.where('businessDayId').equals(dayId).first()
  if (saved) return saved
  const day = await db.businessDays.get(dayId)
  if (!day?.closedAt) throw new Error('The Z report is made when the day closes')
  const z: ZReport = { id: newId(), businessDayId: dayId, branchId: day.branchId, date: day.date, at: new Date().toISOString(), by: userId, report: await loadReport({ kind: 'day', dayId }) }
  await db.zReports.add(z)
  await db.outbox.add({ id: newId(), table: 'zReports', recordId: z.id, at: z.at, synced: 0 })
  await audit({ userId, action: 'report.z', ref: dayId, detail: { net: z.report.net } })
  return z
}

/** Running an X report is logged. It reads the shift as it stands and changes nothing. */
export async function runXReport(shiftId: string, userId: string): Promise<Report> {
  const report = await loadReport({ kind: 'shift', shiftId })
  await audit({ userId, action: 'report.x', ref: shiftId })
  return report
}
