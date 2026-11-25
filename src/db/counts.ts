import { db, type StockCount } from './db'
import { newId } from '../lib/id'
import { levels } from '../lib/stock'
import { toBase } from '../lib/units'
import { cupGap } from '../lib/costs'
import { costOf } from '../lib/purchasing'
import { lineTotal } from '../lib/cart'
import { can } from '../lib/roles'
import { audit } from './audit'
import { alertNegative, syncModifierAvailability, writeMoves } from './stock'

/** What the counter sees: names and units, never what the system expects (a blind count). */
export async function countSheet() {
  return (await db.ingredients.filter((i) => i.active).toArray()).sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name, baseUnit, units }) => ({ id, name, baseUnit, units }))
}

/**
 * Saves a count. Expected is worked out here, as of the moment of counting, so sales rung up after that time do not distort the
 * variance (a Sunday-afternoon count while the shop is open). Only ingredients that were actually counted are included; 0 is a count.
 * The level changes only when someone applies the count.
 */
export async function submitCount(i: {
  branchId: string; countedAt?: string; entries: { ingredientId: string; qty: number; unit: string }[]; userId: string; idempotencyKey: string
}): Promise<StockCount> {
  const prior = await db.stockCounts.where('idempotencyKey').equals(i.idempotencyKey).first()
  if (prior) return prior
  if (!(await db.branches.get(i.branchId))) throw new Error('Pick a branch')
  if (i.entries.length === 0) throw new Error('Count at least one ingredient')
  const countedAt = i.countedAt ? new Date(i.countedAt) : new Date()
  if (Number.isNaN(countedAt.getTime()) || countedAt.getTime() > Date.now() + 60_000) throw new Error('The count time cannot be in the future')
  const upTo = (await db.stockMoves.toArray()).filter((m) => m.at <= countedAt.toISOString())
  const expected = levels(upTo, i.branchId)
  const lines: StockCount['lines'] = []
  for (const e of i.entries) {
    const ing = await db.ingredients.get(e.ingredientId)
    if (!ing) throw new Error('Unknown ingredient')
    if (lines.some((l) => l.ingredientId === ing.id)) throw new Error(`${ing.name} is counted twice`)
    const counted = toBase(ing, e.qty, e.unit)
    if (counted < 0) throw new Error(`${ing.name}: a count cannot be negative`)
    const exp = expected.get(ing.id) ?? 0
    lines.push({ ingredientId: ing.id, counted, expected: exp, variance: Math.round((counted - exp) * 1000) / 1000, ...(ing.avgCostMilli !== undefined && { avgCostMilli: ing.avgCostMilli }) })
  }
  const c: StockCount = { id: newId(), branchId: i.branchId, countedAt: countedAt.toISOString(), at: new Date().toISOString(), by: i.userId, lines, status: 'submitted', idempotencyKey: i.idempotencyKey }
  await db.stockCounts.add(c)
  await audit({ userId: i.userId, action: 'stock.count.submit', ref: c.id, detail: { lines: lines.length, variancePesos: pesosOf(c) } })
  return c
}

/** Net peso effect of the differences (negative = stock is missing). */
export const pesosOf = (c: Pick<StockCount, 'lines'>) => c.lines.reduce((s, l) => s + costOf(l.variance, l.avgCostMilli), 0)

/** Posts the differences into the ledger, one 'count' movement each. Needs stock authority. A count is applied once. */
export async function applyCount(countId: string, userId: string) {
  const user = await db.users.get(userId)
  if (!user || !can(user.role, 'editStock')) throw new Error('Only a supervisor or the owner applies a count')
  const c = await db.stockCounts.get(countId)
  if (!c) throw new Error('Count not found')
  if (c.status === 'applied') throw new Error('This count was already applied')
  const res = await db.transaction('rw', [db.stockCounts, db.stockMoves, db.settings], async () => {
    await db.stockCounts.update(countId, { status: 'applied', appliedAt: new Date().toISOString(), appliedBy: userId })
    return writeMoves(c.lines.map((l) => ({ ingredientId: l.ingredientId, branchId: c.branchId, kind: 'count' as const, qty: l.variance, userId, ref: c.id, note: 'stock count' })))
  })
  await audit({ userId, action: 'stock.count.apply', ref: countId, detail: { lines: c.lines.length, variancePesos: pesosOf(c) } })
  await alertNegative(res.crossed, userId)
  await syncModifierAvailability(userId)
}

/** The variance report: expected, counted and the gap in units and in pesos, plus cup-count gaps with the sales they may hide. */
export async function countReport(countId: string) {
  const c = await db.stockCounts.get(countId)
  if (!c) throw new Error('Count not found')
  const ings = new Map((await db.ingredients.toArray()).map((i) => [i.id, i]))
  const rows = c.lines.map((l) => ({ ...l, ingredient: ings.get(l.ingredientId)!, pesos: costOf(l.variance, l.avgCostMilli) })).sort((a, b) => a.pesos - b.pesos)

  // What a drink usually sells for since the last count: the cups missing are drinks that may have gone out unrung.
  const prev = (await db.stockCounts.where('branchId').equals(c.branchId).toArray()).filter((x) => x.countedAt < c.countedAt).sort((a, b) => b.countedAt.localeCompare(a.countedAt))[0]
  const branchOrders = await db.orders.filter((o) => o.branchId === c.branchId && o.status === 'paid' && o.paidAt <= c.countedAt).toArray()
  const since = branchOrders.filter((o) => !prev || o.paidAt > prev.countedAt)
  const drinks = (os: typeof branchOrders) => os.flatMap((o) => o.lines.filter((l) => !l.comp))
  // Sales since the last count; if there were none, the branch's overall average is the best guess.
  const paid = drinks(since).length > 0 ? drinks(since) : drinks(branchOrders)
  const units = paid.reduce((s, l) => s + l.qty, 0)
  const avgDrinkPrice = units ? paid.reduce((s, l) => s + lineTotal(l), 0) / units : 0
  const cups = rows.filter((r) => r.ingredient?.cup).map((r) => ({ ingredient: r.ingredient, ...cupGap(r.expected, r.counted, avgDrinkPrice) }))
  return { count: c, rows, totalPesos: rows.reduce((s, r) => s + r.pesos, 0), cups, avgDrinkPrice: Math.round(avgDrinkPrice) }
}

export const setCup = async (ingredientId: string, cup: boolean, userId: string) => {
  await db.ingredients.update(ingredientId, { cup })
  await audit({ userId, action: 'ingredient.cup', ref: ingredientId, detail: { cup } })
}
