import { db, type PurchaseOrder, type Receipt, type Supplier } from './db'
import { newId } from '../lib/id'
import { levels } from '../lib/stock'
import { toBase } from '../lib/units'
import { addDays, newAverageMilli, suggestOrder } from '../lib/purchasing'
import { audit } from './audit'
import { alertNegative, writeMoves } from './stock'
import { syncModifierAvailability } from './stock'
import { businessDate } from './businessDate'
import { getSetting } from './settings'

// ---- suppliers ----
export async function createSupplier(name: string, termsDays: number, userId: string): Promise<Supplier> {
  const n = name.trim()
  if (!n) throw new Error('Supplier name is required')
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 365) throw new Error('Payment terms are 0 (pay on delivery) to 365 days')
  if ((await db.suppliers.toArray()).some((s) => s.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  const s: Supplier = { id: newId(), name: n, termsDays, active: true }
  await db.suppliers.add(s)
  await audit({ userId, action: 'supplier.create', ref: s.id, detail: { name: n, termsDays } })
  return s
}

export async function setSupplierActive(id: string, active: boolean, userId: string) {
  await db.suppliers.update(id, { active })
  await audit({ userId, action: active ? 'supplier.restore' : 'supplier.archive', ref: id })
}

/** Par level: how much of an ingredient should be on hand. Purchase orders suggest the gap. */
export async function setPar(ingredientId: string, qty: number, unit: string, userId: string) {
  const ing = await db.ingredients.get(ingredientId)
  if (!ing) throw new Error('Ingredient not found')
  const par = toBase(ing, qty, unit)
  if (par < 0) throw new Error('Par cannot be negative')
  await db.ingredients.update(ingredientId, { par })
  await audit({ userId, action: 'ingredient.par', ref: ingredientId, detail: { par } })
}

/** What to order to bring each ingredient up to its par, for one branch. */
export async function suggestedOrder(branchId: string) {
  return suggestOrder(await db.ingredients.filter((i) => i.active).toArray(), levels(await db.stockMoves.toArray(), branchId))
}

// ---- purchase orders ----
export async function createPurchaseOrder(i: { supplierId: string; branchId: string; lines: { ingredientId: string; qty: number; unit: string }[]; userId: string }): Promise<PurchaseOrder> {
  const supplier = await db.suppliers.get(i.supplierId)
  if (!supplier?.active) throw new Error('Pick an active supplier')
  if (!(await db.branches.get(i.branchId))) throw new Error('Pick a branch')
  if (i.lines.length === 0) throw new Error('Add at least one ingredient')
  const lines: PurchaseOrder['lines'] = []
  for (const l of i.lines) {
    const ing = await db.ingredients.get(l.ingredientId)
    if (!ing?.active) throw new Error('Pick an ingredient for every row')
    const qty = toBase(ing, l.qty, l.unit)
    if (qty <= 0) throw new Error('Enter an amount more than 0')
    if (lines.some((x) => x.ingredientId === ing.id)) throw new Error(`${ing.name} is listed twice`)
    lines.push({ ingredientId: ing.id, qty })
  }
  const po = await db.transaction('rw', [db.purchaseOrders, db.counters], async () => {
    const c = (await db.counters.get('po'))?.last ?? 0
    await db.counters.put({ id: 'po', last: c + 1 })
    const p: PurchaseOrder = { id: newId(), number: `PO-${String(c + 1).padStart(4, '0')}`, supplierId: i.supplierId, branchId: i.branchId, status: 'open', lines, at: new Date().toISOString(), by: i.userId }
    await db.purchaseOrders.add(p)
    return p
  })
  await audit({ userId: i.userId, action: 'po.create', ref: po.id, detail: { number: po.number, lines: lines.length } })
  return po
}

/** Ordered, received and still to come, per line (the three numbers). */
export async function poProgress(poId: string) {
  const po = await db.purchaseOrders.get(poId)
  if (!po) throw new Error('Purchase order not found')
  const received = (await db.receipts.where('poId').equals(poId).toArray()).flatMap((r) => r.lines)
  return po.lines.map((l) => {
    const got = received.filter((r) => r.ingredientId === l.ingredientId).reduce((s, r) => s + r.receivedQty, 0)
    const turnedAway = received.filter((r) => r.ingredientId === l.ingredientId).reduce((s, r) => s + r.rejectedQty, 0)
    return { ingredientId: l.ingredientId, ordered: l.qty, received: got, rejected: turnedAway, outstanding: Math.max(0, Math.round((l.qty - got) * 1000) / 1000) }
  })
}

/** The supplier will not send the rest (ordered 24 L, got 20): close the PO short, with a reason. */
export async function closePoShort(poId: string, userId: string, note: string) {
  if (!note.trim()) throw new Error('A reason is required')
  const po = await db.purchaseOrders.get(poId)
  if (!po || po.status !== 'open') throw new Error('This purchase order is not open')
  await db.purchaseOrders.update(poId, { status: 'closed', closedShort: true, closeNote: note.trim() })
  await audit({ userId, action: 'po.closeShort', ref: poId, detail: { note: note.trim() } })
}

// ---- receiving ----
export type ReceiveLine = { ingredientId: string; qty: number; unit: string; rejectedQty?: number; rejectReason?: string; cost: number /* centavos on the invoice for what was kept */ }

/**
 * Counts a delivery in. What arrived goes into stock at the invoice price, and the ingredient's weighted average cost moves with it.
 * Rejected goods never enter stock; they are recorded as a supplier return with a reason. A short delivery leaves the PO open for the rest.
 * Without a PO it is allowed but waits for a supervisor to review. arrivedAt can be earlier (supplier came at 6 AM, counted later).
 */
export async function receiveDelivery(i: {
  supplierId: string; branchId: string; poId?: string; invoiceNo?: string; arrivedAt?: string; lines: ReceiveLine[]; userId: string; idempotencyKey: string
}): Promise<Receipt> {
  const prior = await db.receipts.where('idempotencyKey').equals(i.idempotencyKey).first()
  if (prior) return prior
  const supplier = await db.suppliers.get(i.supplierId)
  if (!supplier?.active) throw new Error('Pick an active supplier')
  if (!(await db.branches.get(i.branchId))) throw new Error('Pick a branch')
  if (i.lines.length === 0) throw new Error('Add what arrived')
  const arrived = i.arrivedAt ? new Date(i.arrivedAt) : new Date()
  if (Number.isNaN(arrived.getTime()) || arrived.getTime() > Date.now() + 60_000) throw new Error('The arrival time cannot be in the future')
  const inv = i.invoiceNo?.trim()
  if (inv && (await db.receipts.where('supplierId').equals(i.supplierId).toArray()).some((r) => r.invoiceNo?.toLowerCase() === inv.toLowerCase())) {
    throw new Error(`Invoice ${inv} from ${supplier.name} was already received`)
  }
  if (i.poId) {
    const po = await db.purchaseOrders.get(i.poId)
    if (!po || po.status !== 'open') throw new Error('That purchase order is not open')
    if (po.supplierId !== i.supplierId) throw new Error('That purchase order is for a different supplier')
  }

  const lines: Receipt['lines'] = []
  const seen = new Set<string>()
  for (const l of i.lines) {
    const ing = await db.ingredients.get(l.ingredientId)
    if (!ing?.active) throw new Error('Pick an ingredient for every row')
    if (seen.has(ing.id)) throw new Error(`${ing.name} is listed twice. Combine the amounts.`)
    seen.add(ing.id)
    const got = toBase(ing, l.qty, l.unit)
    const bad = l.rejectedQty ? toBase(ing, l.rejectedQty, l.unit) : 0
    if (got < 0 || bad < 0) throw new Error('Amounts cannot be negative')
    if (got === 0 && bad === 0) throw new Error(`Enter how much ${ing.name} arrived or was turned away`)
    if (bad > 0 && !l.rejectReason?.trim()) throw new Error(`Say why ${ing.name} was rejected`)
    if (!Number.isInteger(l.cost) || l.cost < 0) throw new Error(`Enter the invoice amount for ${ing.name} in pesos`)
    lines.push({ ingredientId: ing.id, receivedQty: got, rejectedQty: bad, ...(bad > 0 && { rejectReason: l.rejectReason!.trim() }), cost: got > 0 ? l.cost : 0, unitCostMilli: got > 0 ? Math.round((l.cost * 1000) / got) : 0 })
  }
  const date = businessDate(arrived, await getSetting('dayCutoffHour'))
  const r: Receipt = {
    id: newId(), ...(i.poId && { poId: i.poId }), supplierId: i.supplierId, branchId: i.branchId, ...(inv && { invoiceNo: inv }),
    arrivedAt: arrived.toISOString(), at: new Date().toISOString(), by: i.userId, lines, total: lines.reduce((s, l) => s + l.cost, 0),
    needsReview: !i.poId, dueDate: addDays(date, supplier.termsDays), idempotencyKey: i.idempotencyKey,
  }
  const crossed = await db.transaction('rw', [db.receipts, db.purchaseOrders, db.ingredients, db.stockMoves, db.settings, db.outbox], async () => {
    // Weighted average cost: what is on the shelf now (never counting negative stock) mixed with what just arrived at the invoice price.
    const total = levels(await db.stockMoves.toArray())
    for (const l of lines) {
      if (l.receivedQty <= 0) continue
      const ing = (await db.ingredients.get(l.ingredientId))!
      const onHand = Math.max(0, total.get(l.ingredientId) ?? 0)
      await db.ingredients.update(l.ingredientId, { avgCostMilli: newAverageMilli(onHand, ing.avgCostMilli, l.receivedQty, l.unitCostMilli) })
    }
    await db.receipts.add(r)
    await db.outbox.add({ id: newId(), table: 'receipts', recordId: r.id, at: r.at, synced: 0 })
    const res = await writeMoves(
      lines.filter((l) => l.receivedQty > 0).map((l) => ({ ingredientId: l.ingredientId, branchId: i.branchId, kind: 'receive' as const, qty: l.receivedQty, userId: i.userId, ref: r.id, unitCostMilli: l.unitCostMilli })),
      arrived,
    )
    if (i.poId) {
      const po = (await db.purchaseOrders.get(i.poId))!
      const got = (await db.receipts.where('poId').equals(i.poId).toArray()).flatMap((x) => x.lines)
      const done = po.lines.every((pl) => got.filter((g) => g.ingredientId === pl.ingredientId).reduce((s, g) => s + g.receivedQty, 0) >= pl.qty)
      if (done) await db.purchaseOrders.update(i.poId, { status: 'closed' })
    }
    return res.crossed
  })
  await audit({ userId: i.userId, action: 'stock.receive.delivery', ref: r.id, detail: { total: r.total, poId: i.poId, rejected: lines.filter((l) => l.rejectedQty > 0).length, noPo: !i.poId } })
  await alertNegative(crossed, i.userId)
  await syncModifierAvailability(i.userId)
  return r
}

/** A supervisor looks at a delivery that came without a PO (the regular egg man dropping off). */
export async function reviewReceipt(id: string, supervisorId: string) {
  const r = await db.receipts.get(id)
  if (!r) throw new Error('Delivery not found')
  if (r.by === supervisorId) throw new Error('Ask another supervisor to review a delivery you received')
  await db.receipts.update(id, { needsReview: false, reviewedBy: supervisorId })
  await audit({ userId: supervisorId, action: 'receipt.review', ref: id })
}

// ---- paying the supplier ----
/**
 * Marks a delivery paid. Cash comes out of the drawer, so it must point at a paid-out (2C) of the same amount that no other
 * delivery has used. A bank transfer needs its reference. Full payment only.
 * ponytail: no partial payments or supplier credit notes; a rejected line already lowers the invoice total.
 */
export async function payReceipt(i: { receiptId: string; method: 'cash' | 'transfer'; reference?: string; cashMovementId?: string; userId: string }) {
  const r = await db.receipts.get(i.receiptId)
  if (!r) throw new Error('Delivery not found')
  if (r.paidAt) throw new Error('This delivery is already paid')
  if (i.method === 'transfer') {
    if (!i.reference?.trim()) throw new Error('Enter the bank transfer reference')
  } else {
    const m = i.cashMovementId ? await db.cashMovements.get(i.cashMovementId) : undefined
    if (!m || m.kind !== 'paid-out') throw new Error('Pick the paid-out that took this cash from the drawer')
    if (m.amount !== r.total) throw new Error('The paid-out is not the same amount as the invoice')
    if ((await db.receipts.toArray()).some((x) => x.cashMovementId === m.id)) throw new Error('That paid-out already paid another delivery')
  }
  await db.receipts.update(i.receiptId, {
    paidAt: new Date().toISOString(), paidBy: i.userId, payMethod: i.method,
    ...(i.method === 'transfer' ? { payRef: i.reference!.trim() } : { cashMovementId: i.cashMovementId }),
  })
  await audit({ userId: i.userId, action: 'receipt.pay', ref: i.receiptId, detail: { method: i.method, total: r.total } })
}

/** Unpaid deliveries, oldest due date first, flagged overdue. */
export async function payables(today: string) {
  return (await db.receipts.filter((r) => !r.paidAt && r.total > 0).toArray()).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((r) => ({ ...r, overdue: r.dueDate < today }))
}
