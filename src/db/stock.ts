import { db, type Order, type StockMove } from './db'
import { newId } from '../lib/id'
import { checkWasteReason, levels } from '../lib/stock'
import { toBase } from '../lib/units'
import { businessDate } from './businessDate'
import { getSetting } from './settings'
import { audit } from './audit'
import { deductionsForLine } from './recipes'

type NewMove = Pick<StockMove, 'ingredientId' | 'branchId' | 'kind' | 'qty' | 'userId'> & Partial<Pick<StockMove, 'ref' | 'reason' | 'note' | 'recipeVersions' | 'pairId' | 'unitCostMilli'>>

/** Writes movements (append-only). Returns the ingredients this pushed below zero, so the caller can alert. Call inside a transaction on stockMoves. */
async function write(moves: NewMove[], at = new Date()) {
  const date = businessDate(at, await getSetting('dayCutoffHour'))
  const rows: StockMove[] = moves.filter((m) => m.qty !== 0).map((m) => ({ ...m, id: newId(), at: at.toISOString(), businessDate: date }))
  const crossed: { ingredientId: string; branchId: string; level: number }[] = []
  for (const r of rows) {
    const before = levels(await db.stockMoves.where('ingredientId').equals(r.ingredientId).toArray(), r.branchId).get(r.ingredientId) ?? 0
    await db.stockMoves.add(r)
    if (before >= 0 && before + r.qty < 0) crossed.push({ ingredientId: r.ingredientId, branchId: r.branchId, level: Math.round((before + r.qty) * 1000) / 1000 })
  }
  return { rows, crossed }
}

export { write as writeMoves, alertNegative }
const alertNegative = (crossed: { ingredientId: string; branchId: string; level: number }[], userId: string) =>
  Promise.all(crossed.map((c) => audit({ userId, action: 'stock.negative', ref: c.ingredientId, detail: { branchId: c.branchId, level: c.level } })))

/** Current stock per ingredient, for one branch or all of them. */
export async function stockLevels(branchId?: string) {
  return levels(await db.stockMoves.toArray(), branchId)
}

export async function negativeStock(branchId?: string) {
  const names = new Map((await db.ingredients.toArray()).map((i) => [i.id, i.name]))
  return [...(await stockLevels(branchId))].filter(([, q]) => q < 0).map(([id, qty]) => ({ ingredientId: id, name: names.get(id) ?? '?', qty }))
}

/**
 * A paid order uses up its recipes. Runs inside the sale's transaction so an order and its stock always agree.
 * Never blocks a sale: a drink with no recipe uses nothing, and stock may go negative. Comped lines still deduct.
 * Returns what went below zero (the caller alerts after the sale is saved).
 */
export async function deductSale(order: Pick<Order, 'id' | 'branchId' | 'orderType' | 'lines' | 'paidAt'>, userId: string) {
  const moves: NewMove[] = []
  const costs = new Map((await db.ingredients.toArray()).map((i) => [i.id, i.avgCostMilli]))
  for (const l of order.lines) {
    const d = await deductionsForLine(l, order.orderType)
    for (const u of d.uses) moves.push({ ingredientId: u.ingredientId, branchId: order.branchId, kind: 'sale', qty: -u.qty, userId, ref: order.id, recipeVersions: d.versions, ...(costs.get(u.ingredientId) && { unitCostMilli: costs.get(u.ingredientId) }) })
  }
  return write(moves, new Date(order.paidAt))
}

/** A remade drink uses its ingredients a second time. The first cup was already deducted at the sale and is marked wasted. */
export async function deductRemake(order: Order, lineId: string, userId: string) {
  const l = order.lines.find((x) => x.id === lineId)
  if (!l) return
  const d = await deductionsForLine(l, order.orderType)
  const res = await write(d.uses.map((u) => ({ ingredientId: u.ingredientId, branchId: order.branchId, kind: 'waste' as const, qty: -u.qty, userId, ref: order.id, reason: 'remake', recipeVersions: d.versions })))
  return res
}

/** A voided order was never made: put back exactly what its sale took. */
export async function returnVoided(orderId: string, userId: string) {
  const sold = (await db.stockMoves.where('ref').equals(orderId).toArray()).filter((m) => m.kind === 'sale')
  await write(sold.map((m) => ({ ingredientId: m.ingredientId, branchId: m.branchId, kind: 'void' as const, qty: -m.qty, userId, ref: orderId })))
}

/** The waste screen: spoiled milk, a spilled cup, grinder calibration, a staff meal. A reason is required. */
export async function recordWaste(i: { ingredientId: string; branchId: string; qty: number; unit: string; reason: string; note?: string; userId: string }) {
  checkWasteReason(i.reason, i.note)
  const ing = await db.ingredients.get(i.ingredientId)
  if (!ing) throw new Error('Pick an ingredient')
  const qty = toBase(ing, i.qty, i.unit)
  if (qty <= 0) throw new Error('Enter an amount more than 0')
  const res = await db.transaction('rw', [db.stockMoves, db.settings], () => write([{ ingredientId: i.ingredientId, branchId: i.branchId, kind: 'waste', qty: -qty, userId: i.userId, reason: i.reason, ...(i.note?.trim() && { note: i.note.trim() }) }]))
  await audit({ userId: i.userId, action: 'stock.waste', ref: i.ingredientId, detail: { qty, reason: i.reason, note: i.note?.trim() || undefined, branchId: i.branchId } })
  await alertNegative(res.crossed, i.userId)
  await syncModifierAvailability(i.userId)
  return res.rows[0]
}

/**
 * Stock coming in. ponytail: a plain "received" entry; purchase orders, supplier invoice prices and average cost come in 3D.
 */
export async function receiveStock(i: { ingredientId: string; branchId: string; qty: number; unit: string; note?: string; userId: string }) {
  const ing = await db.ingredients.get(i.ingredientId)
  if (!ing) throw new Error('Pick an ingredient')
  const qty = toBase(ing, i.qty, i.unit)
  if (qty <= 0) throw new Error('Enter an amount more than 0')
  const res = await db.transaction('rw', [db.stockMoves, db.settings], () => write([{ ingredientId: i.ingredientId, branchId: i.branchId, kind: 'receive', qty, userId: i.userId, ...(i.note?.trim() && { note: i.note.trim() }) }]))
  await audit({ userId: i.userId, action: 'stock.receive', ref: i.ingredientId, detail: { qty, branchId: i.branchId } })
  await syncModifierAvailability(i.userId)
  return res.rows[0]
}

/** Branch 1 lends 6 L of milk to branch 2: one movement out and one in, linked by a pair id. */
export async function transferStock(i: { ingredientId: string; fromBranchId: string; toBranchId: string; qty: number; unit: string; userId: string }) {
  if (i.fromBranchId === i.toBranchId) throw new Error('Pick two different branches')
  const ing = await db.ingredients.get(i.ingredientId)
  if (!ing) throw new Error('Pick an ingredient')
  const qty = toBase(ing, i.qty, i.unit)
  if (qty <= 0) throw new Error('Enter an amount more than 0')
  const pairId = newId()
  const res = await db.transaction('rw', [db.stockMoves, db.settings], () => write([
    { ingredientId: i.ingredientId, branchId: i.fromBranchId, kind: 'transfer-out', qty: -qty, userId: i.userId, pairId },
    { ingredientId: i.ingredientId, branchId: i.toBranchId, kind: 'transfer-in', qty, userId: i.userId, pairId },
  ]))
  await audit({ userId: i.userId, action: 'stock.transfer', ref: i.ingredientId, detail: { qty, from: i.fromBranchId, to: i.toBranchId } })
  await alertNegative(res.crossed, i.userId)
  return pairId
}

/** Raw ingredients become a prep item with a yield: 1 kg beans + 8 L water make 6.5 L cold brew. */
export async function produce(i: { branchId: string; inputs: { ingredientId: string; qty: number; unit: string }[]; outputIngredientId: string; outQty: number; outUnit: string; userId: string }) {
  if (i.inputs.length === 0) throw new Error('Add what goes in')
  const out = await db.ingredients.get(i.outputIngredientId)
  if (!out) throw new Error('Pick what is made')
  const outQty = toBase(out, i.outQty, i.outUnit)
  if (outQty <= 0) throw new Error('Enter how much was made')
  const pairId = newId()
  const moves: NewMove[] = []
  for (const inp of i.inputs) {
    const ing = await db.ingredients.get(inp.ingredientId)
    if (!ing) throw new Error('Pick an ingredient for every input')
    const q = toBase(ing, inp.qty, inp.unit)
    if (q <= 0) throw new Error('Enter an amount more than 0')
    moves.push({ ingredientId: ing.id, branchId: i.branchId, kind: 'production', qty: -q, userId: i.userId, pairId })
  }
  moves.push({ ingredientId: out.id, branchId: i.branchId, kind: 'production', qty: outQty, userId: i.userId, pairId })
  const res = await db.transaction('rw', [db.stockMoves, db.settings], () => write(moves))
  await audit({ userId: i.userId, action: 'stock.produce', ref: out.id, detail: { outQty, branchId: i.branchId } })
  await alertNegative(res.crossed, i.userId)
  await syncModifierAvailability(i.userId)
}

/**
 * A count correction: the ledger gets one movement for the difference, the level is never overwritten.
 * ponytail: the blind count screen and variance report are 3E; this is the movement they will write.
 */
export async function adjustToCount(i: { ingredientId: string; branchId: string; counted: number; unit: string; note?: string; userId: string }) {
  const ing = await db.ingredients.get(i.ingredientId)
  if (!ing) throw new Error('Pick an ingredient')
  const counted = toBase(ing, i.counted, i.unit)
  if (counted < 0) throw new Error('A count cannot be negative')
  const now = (await stockLevels(i.branchId)).get(i.ingredientId) ?? 0
  const diff = Math.round((counted - now) * 1000) / 1000
  const res = await db.transaction('rw', [db.stockMoves, db.settings], () => write([{ ingredientId: i.ingredientId, branchId: i.branchId, kind: 'count', qty: diff, userId: i.userId, ...(i.note?.trim() && { note: i.note.trim() }) }]))
  await audit({ userId: i.userId, action: 'stock.count', ref: i.ingredientId, detail: { counted, was: now, diff, branchId: i.branchId } })
  await syncModifierAvailability(i.userId)
  return { diff, rows: res.rows }
}

/** Raised after a sale is saved: tell a supervisor which ingredients went below zero. */
export const alertAfterSale = alertNegative

/**
 * An add-on switches itself off while any ingredient it needs is out (oat milk runs out → "Oat milk" is sold out), and back on when
 * stock returns. Only switches it turned off are switched back on; a manual "sold out" stays. Drinks themselves are never switched off.
 * ponytail: "out" means zero or less across all branches. Per-branch menus would need per-branch availability (4x).
 */
export async function syncModifierAvailability(userId: string) {
  const total = levels(await db.stockMoves.toArray())
  const recipes = (await db.recipes.toArray()).filter((r) => r.kind === 'modifier')
  const latest = new Map<string, (typeof recipes)[number]>()
  for (const r of recipes) if (!latest.has(r.refId) || latest.get(r.refId)!.version < r.version) latest.set(r.refId, r)
  for (const m of await db.modifiers.filter((x) => x.active).toArray()) {
    const r = latest.get(m.id)
    if (!r) continue
    const needs = r.lines.flatMap((l) => (l.op === 'add' ? [l.ingredientId] : l.op === 'replace' && l.withIngredientId ? [l.withIngredientId] : []))
    const out = needs.some((id) => (total.get(id) ?? 0) <= 0)
    if (out && !m.soldOut) {
      await db.modifiers.update(m.id, { soldOut: true, autoSoldOut: true })
      await audit({ userId, action: 'modifier.autoSoldOut', ref: m.id, detail: { name: m.name } })
    } else if (!out && m.soldOut && m.autoSoldOut) {
      await db.modifiers.update(m.id, { soldOut: false, autoSoldOut: false })
      await audit({ userId, action: 'modifier.autoAvailable', ref: m.id, detail: { name: m.name } })
    }
  }
}
