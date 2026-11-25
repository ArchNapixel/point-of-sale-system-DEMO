import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { closeShift, dayCloseChecklist, openBusinessDay, openShift, submitCloseCount, closeBusinessDay, lateCloseShift } from './db/shifts'
import { approve } from './db/approvals'
import { payOrder, verifyPayment } from './db/orders'
import { refundOrder, voidOrder } from './db/refunds'
import { recordCash } from './db/cash'
import { holdCart, discardHeld } from './db/carts'
import { closeDayAndReport, getZReport, loadReport, runXReport } from './db/reports'
import { addLine, emptyCart, type CartLine } from './lib/cart'

let branch = '', t1 = '', cashier = '', sup = '', day = '', shift = ''
let n = 0
const k = () => `k${++n}`

const line = (id: string, price: number, extra: Partial<CartLine> = {}): CartLine => ({
  id, itemId: 'i' + id, variantId: 'v' + id, name: 'Drink ' + id, variantLabel: '', basePrice: price, mods: [], notes: [], allergy: '', qty: 1, ...extra,
})
const cartOf = (...ls: CartLine[]) => ls.reduce(addLine, emptyCart())
const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]
const pin = (action: 'void' | 'refund' | 'cash', orderOrShiftId: string, amount: number) =>
  approve({ action, requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount, ref: orderOrShiftId })

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branch = (await createBranch('Main')).id
  t1 = (await createTerminal(branch, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  day = (await openBusinessDay(branch, sup)).id
  shift = (await openShift(t1, cashier, { b1000: 2 })).id
})

describe('day-close checklist', () => {
  it('blocks on an open shift, a held cart and a pending GCash, and closes when all are cleared', async () => {
    await holdCart(t1, shift, cashier, cartOf(line('a', 5000)))
    const { order, payments } = await payOrder(t1, cashier, cartOf(line('b', 8000)), [{ method: 'gcash', amount: 8000, reference: 'R1' }], k())
    expect(order.total).toBe(8000)
    await expect(closeBusinessDay(day, sup)).rejects.toThrow(/Close the open shift on Counter 1/)
    await submitCloseCount(shift, cashier, { b1000: 2 })
    await closeShift(shift, cashier)
    const list = await dayCloseChecklist(day)
    expect([list.openShifts.length, list.heldCarts.length, list.pendingPayments.length, list.ok]).toEqual([0, 1, 1, false])
    await expect(closeBusinessDay(day, sup)).rejects.toThrow(/1 held cart/)
    await discardHeld(list.heldCarts[0].id)
    await expect(closeBusinessDay(day, sup)).rejects.toThrow(/pending verification/)
    await verifyPayment(payments[0].id, sup)
    expect((await dayCloseChecklist(day)).ok).toBe(true)
    await closeBusinessDay(day, sup)
    expect((await db.businessDays.get(day))?.closedAt).toBeTruthy()
  })
  it('a supervisor can late-close a shift nobody closed, which clears that item', async () => {
    await lateCloseShift(shift, sup, 'Cashier went home')
    expect((await dayCloseChecklist(day)).ok).toBe(true)
  })
})

describe('report numbers', () => {
  it('net sales = gross - discounts - voids - refunds; comps, payments and drawer cash all line up', async () => {
    const made = (orderId: string) => db.queueItems.where('orderId').equals(orderId).modify({ status: 'served' })
    const A = (await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), k())).order // will be voided
    await payOrder(t1, cashier, { ...cartOf(line('b', 16800)), discount: { kind: 'senior', name: 'Lola', idNumber: 'S1', signed: true, picks: { b: 1 } } }, cash(12000), k())
    const C = await payOrder(t1, cashier, cartOf(line('c', 8000)), [{ method: 'gcash', amount: 8000, reference: 'R1' }], k())
    const D = (await payOrder(t1, cashier, cartOf(line('d', 6000)), cash(6000), k())).order // will be refunded
    await payOrder(t1, cashier, cartOf(line('f', 3000), line('e', 4000, { comp: { code: 'wrong-order', note: '' } })), cash(3000), k())

    await voidOrder({ orderId: A.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: (await pin('void', A.id, 10000)).id, idempotencyKey: k() })
    await made(D.id)
    await refundOrder({ orderId: D.id, terminalId: t1, userId: cashier, reasonCode: 'quality-complaint', approvalId: (await pin('refund', D.id, 6000)).id, idempotencyKey: k(), picks: { d: 1 }, method: 'cash' })
    await recordCash({ shiftId: shift, userId: cashier, kind: 'paid-out', amount: 5000, reason: 'milk', approvalId: (await pin('cash', shift, 5000)).id, idempotencyKey: k() })
    await recordCash({ shiftId: shift, userId: cashier, kind: 'no-sale', amount: 0, reason: 'change for a customer', approvalId: (await pin('cash', shift, 0)).id, idempotencyKey: k() })

    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.gross).toBe(10000 + 16800 + 8000 + 6000 + 3000)
    expect(r.discounts).toMatchObject({ seniorPwd: 4800, promo: 0, staff: 0, total: 4800 })
    expect(r.voids).toEqual({ count: 1, amount: 10000 })
    expect(r.refunds).toEqual({ count: 1, amount: 6000 })
    expect(r.net).toBe(12000 + 8000 + 3000) // B + C + F: what was really sold and kept
    expect(r.comps).toEqual({ count: 1, value: 4000 })
    expect(r.noSales).toBe(1)
    expect(r.seniorPwd).toMatchObject({ count: 1, reduction: 4800, vatExempt: 15000 })
    expect(r.payments.cash).toEqual({ collected: 31000, refunded: 16000, net: 15000 }) // a void goes back the way it was paid
    expect(r.payments.gcash).toEqual({ collected: 8000, refunded: 0, net: 8000 })
    expect(r.pending).toEqual({ count: 1, amount: 8000 })
    expect(r.cash).toMatchObject({ opening: 200000, sales: 31000, refunds: 16000, paidOut: 5000, expected: 200000 + 31000 - 16000 - 5000 })
    expect(C.payments[0].status).toBe('pending')
  })
  it('VAT lines add up to net sales for sold orders', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 11200)), cash(11200), k())
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.vat).toMatchObject({ vatable: 10000, vat: 1200, vatExempt: 0 })
  })
  it('over and short are listed per shift and never netted', async () => {
    await submitCloseCount(shift, cashier, { b1000: 1, b500: 1, b200: 2, b50: 1, b20: 1 }) // ₱1,970: ₱30 short
    await closeShift(shift, cashier, 'Gave wrong change')
    const s2 = (await openShift(t1, cashier, { b1000: 1, b500: 1, b200: 2, b50: 1, b20: 1 })).id // opens with what was left
    await submitCloseCount(s2, cashier, { b1000: 2 }) // ₱2,000: ₱30 over
    await closeShift(s2, cashier, 'Found a ₱50 someone dropped')
    const r = await loadReport({ kind: 'day', dayId: day })
    expect(r.shifts.map((s) => s.overShort).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([-3000, 3000])
    expect(r.shifts.find((s) => s.overShort === -3000)?.note).toBe('Gave wrong change')
  })
})

describe('Z and X reports', () => {
  it('Z is made when the day closes and is frozen: later changes do not rewrite it', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), k())
    await expect(getZReport(day, sup)).rejects.toThrow(/when the day closes/)
    await submitCloseCount(shift, cashier, { b1000: 2, b100: 1 })
    await closeShift(shift, cashier)
    const z = await closeDayAndReport(day, sup)
    expect(z.report.net).toBe(10000)
    await db.orders.toCollection().modify({ gross: 99999 })
    expect((await getZReport(day, sup)).report.net).toBe(10000)
    expect(await db.zReports.count()).toBe(1)
    expect(await db.auditLog.where('action').equals('report.z').count()).toBe(1)
  })
  it('an X report reads the open shift and is logged', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), k())
    const r = await runXReport(shift, sup)
    expect(r.net).toBe(10000)
    expect(r.shifts[0].closed).toBe(false)
    expect(await db.auditLog.where('action').equals('report.x').count()).toBe(1)
  })
  it('the owner dashboard adds up every branch on a business date', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), k())
    const b2 = (await createBranch('Second')).id
    const t2 = (await createTerminal(b2, 'Counter 2', 'T2')).id
    await openBusinessDay(b2, sup)
    await openShift(t2, cashier, { b1000: 2 })
    await payOrder(t2, cashier, cartOf(line('z', 5000)), cash(5000), k())
    const date = (await db.businessDays.get(day))!.date
    expect((await loadReport({ kind: 'date', date })).net).toBe(15000)
    expect((await loadReport({ kind: 'day', dayId: day })).net).toBe(10000)
  })
})
