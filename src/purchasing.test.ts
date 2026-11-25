import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { addUnit, createIngredient } from './db/ingredients'
import { saveRecipe } from './db/recipes'
import { payOrder } from './db/orders'
import { receiveStock, stockLevels } from './db/stock'
import {
  closePoShort, createPurchaseOrder, createSupplier, payables, payReceipt, poProgress, receiveDelivery, reviewReceipt, setPar, suggestedOrder,
} from './db/purchasing'
import { addDays, costOf, newAverageMilli } from './lib/purchasing'
import { addLine, emptyCart } from './lib/cart'

let branch = '', sup = '', clerk = '', supplier = '', milk = '', beans = ''
let n = 0
const k = () => `r${++n}`
const lvl = async (id: string) => (await stockLevels(branch)).get(id) ?? 0

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branch = (await createBranch('Main')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  clerk = (await createUser('Clerk', 'supervisor', '3333')).id
  supplier = (await createSupplier('Dairy Co', 30, sup)).id
  milk = (await createIngredient('Milk', 'ml', 'u')).id
  beans = (await createIngredient('Beans', 'g', 'u')).id
})

describe('pure maths', () => {
  it('weighted average cost: 1 kg at ₱1,200 then 1 kg at ₱1,250 averages ₱1,225', () => {
    const first = newAverageMilli(0, undefined, 1000, 120000) // 120 centavos per g
    expect(first).toBe(120000)
    expect(newAverageMilli(1000, first, 1000, 125000)).toBe(122500)
    expect(costOf(18, 122500)).toBe(2205) // 18 g of beans cost ₱22.05
  })
  it('negative or empty stock does not drag the average', () => {
    expect(newAverageMilli(0, 99999, 500, 8000)).toBe(8000)
  })
  it('dates add on the calendar, across months', () => {
    expect(addDays('2026-11-25', 30)).toBe('2026-12-25')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-02-28', 0)).toBe('2026-02-28')
  })
})

describe('purchase orders', () => {
  it('numbers them PO-0001, PO-0002 and checks the form', async () => {
    const a = await createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 24, unit: 'L' }], userId: sup })
    const b = await createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: beans, qty: 5, unit: 'kg' }], userId: sup })
    expect([a.number, b.number]).toEqual(['PO-0001', 'PO-0002'])
    expect(a.lines).toEqual([{ ingredientId: milk, qty: 24000 }])
    await expect(createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [], userId: sup })).rejects.toThrow(/at least one/)
    await expect(createPurchaseOrder({ supplierId: 'x', branchId: branch, lines: [{ ingredientId: milk, qty: 1, unit: 'L' }], userId: sup })).rejects.toThrow(/supplier/)
    await expect(createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 1, unit: 'L' }, { ingredientId: milk, qty: 2, unit: 'L' }], userId: sup })).rejects.toThrow(/twice/)
  })
  it('par levels suggest the gap, ignoring negative stock', async () => {
    await setPar(milk, 24, 'L', sup)
    await setPar(beans, 5, 'kg', sup)
    await receiveStock({ ingredientId: milk, branchId: branch, qty: 10, unit: 'L', userId: sup })
    await receiveStock({ ingredientId: beans, branchId: branch, qty: 6, unit: 'kg', userId: sup }) // above par: nothing to order
    expect(await suggestedOrder(branch)).toEqual([{ ingredientId: milk, qty: 14000 }])
  })
})

describe('receiving', () => {
  it('a short delivery: ordered 24 L, received 20 L → stock +20 L, PO stays open for 4 L, then fills and closes', async () => {
    const po = await createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 24, unit: 'L' }], userId: sup })
    await receiveDelivery({ supplierId: supplier, branchId: branch, poId: po.id, invoiceNo: 'D-1', lines: [{ ingredientId: milk, qty: 20, unit: 'L', cost: 180000 }], userId: sup, idempotencyKey: k() })
    expect(await lvl(milk)).toBe(20000)
    expect(await poProgress(po.id)).toEqual([{ ingredientId: milk, ordered: 24000, received: 20000, rejected: 0, outstanding: 4000 }])
    expect((await db.purchaseOrders.get(po.id))?.status).toBe('open')
    await receiveDelivery({ supplierId: supplier, branchId: branch, poId: po.id, invoiceNo: 'D-2', lines: [{ ingredientId: milk, qty: 4, unit: 'L', cost: 36000 }], userId: sup, idempotencyKey: k() })
    expect((await db.purchaseOrders.get(po.id))?.status).toBe('closed')
  })
  it('or close it short with a reason', async () => {
    const po = await createPurchaseOrder({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 24, unit: 'L' }], userId: sup })
    await receiveDelivery({ supplierId: supplier, branchId: branch, poId: po.id, lines: [{ ingredientId: milk, qty: 20, unit: 'L', cost: 180000 }], userId: sup, idempotencyKey: k() })
    await expect(closePoShort(po.id, sup, ' ')).rejects.toThrow(/reason/)
    await closePoShort(po.id, sup, 'Supplier is out of stock')
    expect(await db.purchaseOrders.get(po.id)).toMatchObject({ status: 'closed', closedShort: true, closeNote: 'Supplier is out of stock' })
    await expect(receiveDelivery({ supplierId: supplier, branchId: branch, poId: po.id, lines: [{ ingredientId: milk, qty: 4, unit: 'L', cost: 1 }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/not open/)
  })
  it('rejected goods never enter stock, need a reason, and are kept as a supplier return', async () => {
    const line = { ingredientId: milk, qty: 10, unit: 'L', rejectedQty: 2, cost: 90000 }
    await expect(receiveDelivery({ supplierId: supplier, branchId: branch, lines: [line], userId: sup, idempotencyKey: k() })).rejects.toThrow(/why .* rejected/i)
    const r = await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ...line, rejectReason: 'Expiring in 2 days' }], userId: sup, idempotencyKey: k() })
    expect(await lvl(milk)).toBe(10000)
    expect(r.lines[0]).toMatchObject({ receivedQty: 10000, rejectedQty: 2000, rejectReason: 'Expiring in 2 days' })
  })
  it('a delivery with no PO is allowed but waits for a different supervisor to review it', async () => {
    const r = await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 9000 }], userId: sup, idempotencyKey: k() })
    expect(r.needsReview).toBe(true)
    await expect(reviewReceipt(r.id, sup)).rejects.toThrow(/another supervisor/)
    await reviewReceipt(r.id, clerk)
    expect(await db.receipts.get(r.id)).toMatchObject({ needsReview: false, reviewedBy: clerk })
  })
  it('weighted average cost moves with the invoice price (beans up ₱50/kg), and a sale keeps the cost it had', async () => {
    await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: beans, qty: 1, unit: 'kg', cost: 120000 }], userId: sup, idempotencyKey: k() })
    expect((await db.ingredients.get(beans))?.avgCostMilli).toBe(120000)
    await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: beans, qty: 1, unit: 'kg', cost: 125000 }], userId: sup, idempotencyKey: k() })
    expect((await db.ingredients.get(beans))?.avgCostMilli).toBe(122500)

    // a sale records the cost of what it used, so a later price change cannot rewrite it
    const t1 = (await createTerminal(branch, 'Counter 1', 'T1')).id
    const cashier = (await createUser('Cash', 'cashier', '1111')).id
    await openBusinessDay(branch, sup)
    await openShift(t1, cashier, { b1000: 2 })
    await db.variants.add({ id: 'v1', itemId: 'i', size: '16 oz', temp: 'iced', price: 16800, active: true })
    await saveRecipe('variant', 'v1', [{ ingredientId: beans, qty: 18, op: 'add', when: 'always' }], 'u')
    await payOrder(t1, cashier, addLine(emptyCart(), { id: 'a', itemId: 'i', variantId: 'v1', name: 'Latte', variantLabel: '', basePrice: 16800, mods: [], notes: [], allergy: '', qty: 1 }), [{ method: 'cash', tendered: 16800 }], k())
    await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: beans, qty: 1, unit: 'kg', cost: 200000 }], userId: sup, idempotencyKey: k() })
    const sale = (await db.stockMoves.toArray()).find((m) => m.kind === 'sale')
    expect(sale?.unitCostMilli).toBe(122500)
  })
  it('the supplier arrived at 6 AM and it was counted later: the arrival time is kept, and it cannot be in the future', async () => {
    const six = new Date()
    six.setHours(6, 0, 0, 0)
    const r = await receiveDelivery({ supplierId: supplier, branchId: branch, arrivedAt: six.toISOString(), lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 9000 }], userId: sup, idempotencyKey: k() })
    expect(r.arrivedAt).toBe(six.toISOString())
    await expect(receiveDelivery({ supplierId: supplier, branchId: branch, arrivedAt: new Date(Date.now() + 3_600_000).toISOString(), lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 1 }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/future/)
  })
  it('the same invoice is not received twice, and a retry with the same key saves once', async () => {
    const key = k()
    const a = await receiveDelivery({ supplierId: supplier, branchId: branch, invoiceNo: 'INV-9', lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 9000 }], userId: sup, idempotencyKey: key })
    expect((await receiveDelivery({ supplierId: supplier, branchId: branch, invoiceNo: 'INV-9', lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 9000 }], userId: sup, idempotencyKey: key })).id).toBe(a.id)
    await expect(receiveDelivery({ supplierId: supplier, branchId: branch, invoiceNo: 'inv-9', lines: [{ ingredientId: milk, qty: 1, unit: 'L', cost: 9000 }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/already received/)
    expect(await lvl(milk)).toBe(1000)
  })
  it('works in any unit: a case of milk', async () => {
    await addUnit(milk, 'case', 12000, 'u')
    await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: milk, qty: 2, unit: 'case', cost: 216000 }], userId: sup, idempotencyKey: k() })
    expect(await lvl(milk)).toBe(24000)
    expect((await db.ingredients.get(milk))?.avgCostMilli).toBe(9000) // ₱0.09 per ml
  })
})

describe('paying the supplier', () => {
  const today = '2026-11-25'
  const delivered = (cost = 90000, arrivedAt?: string) =>
    receiveDelivery({ supplierId: supplier, branchId: branch, arrivedAt, lines: [{ ingredientId: milk, qty: 10, unit: 'L', cost }], userId: sup, idempotencyKey: k() })

  it('terms of 30 days set the due date; unpaid deliveries list oldest first and flag overdue', async () => {
    const old = await delivered(90000, new Date('2026-10-01T08:00:00').toISOString())
    const fresh = await delivered(50000)
    expect(old.dueDate).toBe('2026-10-31')
    const list = await payables(today)
    expect(list.map((r) => r.id)).toEqual([old.id, fresh.id])
    expect(list.map((r) => r.overdue)).toEqual([true, false])
  })
  it('a bank transfer needs its reference; a delivery is paid once', async () => {
    const r = await delivered()
    await expect(payReceipt({ receiptId: r.id, method: 'transfer', userId: sup })).rejects.toThrow(/reference/)
    await payReceipt({ receiptId: r.id, method: 'transfer', reference: 'BPI-123', userId: sup })
    await expect(payReceipt({ receiptId: r.id, method: 'transfer', reference: 'x', userId: sup })).rejects.toThrow(/already paid/)
    expect(await payables(today)).toEqual([])
  })
  it('paying cash must point at the drawer paid-out of the same amount, used once', async () => {
    const a = await delivered(90000)
    const b = await delivered(90000)
    const move = (id: string, kind: 'paid-out' | 'drop', amount: number) => db.cashMovements.add({ id, shiftId: 's', terminalId: 't', kind, amount, reason: 'milk', userId: sup, approvedBy: sup, businessDate: today, at: 'x', idempotencyKey: id })
    await move('m1', 'paid-out', 90000)
    await move('m2', 'paid-out', 50000)
    await move('m3', 'drop', 90000)
    await expect(payReceipt({ receiptId: a.id, method: 'cash', userId: sup })).rejects.toThrow(/Pick the paid-out/)
    await expect(payReceipt({ receiptId: a.id, method: 'cash', cashMovementId: 'm3', userId: sup })).rejects.toThrow(/Pick the paid-out/)
    await expect(payReceipt({ receiptId: a.id, method: 'cash', cashMovementId: 'm2', userId: sup })).rejects.toThrow(/same amount/)
    await payReceipt({ receiptId: a.id, method: 'cash', cashMovementId: 'm1', userId: sup })
    await expect(payReceipt({ receiptId: b.id, method: 'cash', cashMovementId: 'm1', userId: sup })).rejects.toThrow(/already paid another/)
  })
  it('suppliers: terms and names are checked', async () => {
    await expect(createSupplier('dairy co', 30, sup)).rejects.toThrow(/already exists/)
    await expect(createSupplier('X', -1, sup)).rejects.toThrow(/terms/)
    await expect(createSupplier(' ', 0, sup)).rejects.toThrow(/name/)
  })
})
