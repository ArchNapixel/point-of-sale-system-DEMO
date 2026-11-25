import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { expectedCash, openBusinessDay, openShift } from './db/shifts'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { pickedAmount, refundableLines, refundOrder, voidOrder } from './db/refunds'
import { remakeItem } from './db/queue'
import { addLine, compTotal, emptyCart, type CartLine } from './lib/cart'

let t1 = ''
let cashier = '', sup = '', barista = ''
let n = 0
const key = () => `k${++n}`

const line = (id: string, price: number, qty = 1, extra: Partial<CartLine> = {}): CartLine => ({
  id, itemId: 'i' + id, variantId: 'v' + id, name: 'Drink ' + id, variantLabel: '16 oz', basePrice: price, mods: [], notes: [], allergy: '', qty, ...extra,
})
const cartOf = (...lines: CartLine[]) => lines.reduce(addLine, emptyCart())
const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  barista = (await createUser('Bar', 'barista', '4444')).id
  await openBusinessDay(b.id, sup)
  await openShift(t1, cashier, { b1000: 2 })
})

const pin = (action: 'void' | 'refund', requesterId: string, orderId: string, amount: number, approverId = sup, p = '2222') =>
  approve({ action, requesterId, approverId, pin: p, terminalId: t1, amount, ref: orderId })
const voidArgs = (orderId: string, approvalId?: string, extra = {}) =>
  ({ orderId, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId, idempotencyKey: key(), ...extra })

describe('void (whole order, nothing made yet)', () => {
  it('always needs a supervisor PIN; with one, the order is VOID, the invoice number stays, tickets leave the bar', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000), line('b', 8000)), cash(18000), key())
    await expect(voidOrder(voidArgs(order.id))).rejects.toThrow(/supervisor PIN/)
    const r = await voidOrder(voidArgs(order.id, (await pin('void', cashier, order.id, 18000)).id))
    expect(r).toMatchObject({ kind: 'void', amount: 18000, cashAmount: 18000, invoiceNo: 'T1-000001', approvedBy: sup, madeBefore: false })
    expect(await db.orders.get(order.id)).toMatchObject({ status: 'void', invoiceNo: 'T1-000001' })
    expect((await db.queueItems.toArray()).every((q) => q.status === 'void')).toBe(true)
    expect((await payOrder(t1, cashier, cartOf(line('a', 100)), cash(100), key())).order.invoiceNo).toBe('T1-000002') // number not reused
  })
  it('needs a fixed reason; "Other" needs a note', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    const a = await pin('void', cashier, order.id, 10000)
    await expect(voidOrder(voidArgs(order.id, a.id, { reasonCode: '' }))).rejects.toThrow(/Pick a reason/)
    await expect(voidOrder(voidArgs(order.id, a.id, { reasonCode: 'other' }))).rejects.toThrow(/note/)
    await expect(voidOrder(voidArgs(order.id, a.id, { reasonCode: 'other', reasonNote: 'Customer left' }))).resolves.toBeTruthy()
  })
  it('is refused once drinks are being made, and cannot happen twice', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    await db.queueItems.toCollection().modify({ status: 'making' })
    await expect(voidOrder(voidArgs(order.id, (await pin('void', cashier, order.id, 10000)).id))).rejects.toThrow(/already being made/)
    await db.queueItems.toCollection().modify({ status: 'queued' })
    await voidOrder(voidArgs(order.id, (await pin('void', cashier, order.id, 10000)).id))
    await expect(voidOrder(voidArgs(order.id, (await pin('void', cashier, order.id, 10000)).id))).rejects.toThrow(/already voided/)
  })
  it('a supervisor voiding their own sale needs their PIN and is flagged self-approved', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    const a = await pin('void', sup, order.id, 10000)
    expect(a.selfApproved).toBe(true)
    await voidOrder(voidArgs(order.id, a.id, { userId: sup }))
    expect((await db.auditLog.where('action').equals('order.void').first())?.detail?.selfApproved).toBe(true)
  })
  it('the same key never voids twice', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    const args = voidArgs(order.id, (await pin('void', cashier, order.id, 10000)).id)
    const a = await voidOrder(args)
    expect((await voidOrder(args)).id).toBe(a.id)
    expect(await db.refunds.count()).toBe(1)
  })
})

describe('refund (after it was made)', () => {
  const made = () => db.queueItems.toCollection().modify({ status: 'served' })
  const refundArgs = (orderId: string, picks: Record<string, number>, approvalId?: string, extra = {}) =>
    ({ ...voidArgs(orderId, approvalId), picks, method: 'cash' as const, ...extra })

  it('refunds one of three lines, linked to the invoice, flagged as made (waste), and cash leaves today’s drawer', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000), line('b', 8000), line('c', 6000)), cash(24000), key())
    await made()
    const before = await expectedCash((await db.shifts.toCollection().first())!.id)
    const r = await refundOrder(refundArgs(order.id, { b: 1 }, (await pin('refund', cashier, order.id, 8000)).id))
    expect(r).toMatchObject({ kind: 'refund', amount: 8000, cashAmount: 8000, invoiceNo: 'T1-000001', madeBefore: true, lines: [{ lineId: 'b', units: 1, amount: 8000 }] })
    expect(await expectedCash(r.shiftId)).toBe(before - 8000)
    expect((await db.orders.get(order.id))?.status).toBe('paid') // a partial refund is not a void
  })
  it('is dated today even when the sale was on an earlier day', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    await db.orders.update(order.id, { businessDate: '2020-01-01' })
    await made()
    const r = await refundOrder(refundArgs(order.id, { a: 1 }, (await pin('refund', cashier, order.id, 10000)).id))
    expect(r.businessDate).toBe((await db.businessDays.toCollection().first())!.date)
    expect(r.businessDate).not.toBe('2020-01-01')
  })
  it('an e-wallet refund does not touch the drawer', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), [{ method: 'gcash', amount: 10000, reference: 'R1' }], key())
    await made()
    const r = await refundOrder(refundArgs(order.id, { a: 1 }, (await pin('refund', cashier, order.id, 10000)).id, { method: 'gcash' }))
    expect(r).toMatchObject({ method: 'gcash', cashAmount: 0 })
  })
  it('refunds in pieces never add up to more than was paid, and rounding drift lands on the last unit', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000, 3)), cash(30000), key())
    await made()
    const amounts: number[] = []
    for (let i = 0; i < 3; i++) {
      const rows = await refundableLines(order.id)
      amounts.push(pickedAmount(rows, { a: 1 }))
      await refundOrder(refundArgs(order.id, { a: 1 }, (await pin('refund', cashier, order.id, amounts[i])).id))
    }
    expect(amounts).toEqual([10000, 10000, 10000])
    await expect(refundOrder(refundArgs(order.id, { a: 1 }, (await pin('refund', cashier, order.id, 10000)).id))).rejects.toThrow(/Only 0/)
  })
  it('a discounted line refunds what was actually paid for it', async () => {
    const c = { ...cartOf(line('a', 16800)), discount: { kind: 'senior' as const, name: 'Lola', idNumber: 'S1', signed: true, picks: { a: 1 } } }
    const { order } = await payOrder(t1, cashier, c, cash(12000), key())
    await made()
    expect((await refundableLines(order.id))[0].net).toBe(12000)
  })
  it('needs a supervisor PIN, and a PIN for a smaller amount does not cover it', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    await made()
    await expect(refundOrder(refundArgs(order.id, { a: 1 }))).rejects.toThrow(/supervisor PIN/)
    await expect(refundOrder(refundArgs(order.id, { a: 1 }, (await pin('refund', cashier, order.id, 5000)).id))).rejects.toThrow(/supervisor PIN/)
    await expect(refundOrder(refundArgs(order.id, {}, (await pin('refund', cashier, order.id, 5000)).id))).rejects.toThrow(/Pick what to refund/)
  })
  it('cannot refund without an open shift to take the cash from', async () => {
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    await db.shifts.toCollection().modify({ closedAt: 'x' })
    await expect(refundOrder(refundArgs(order.id, { a: 1 }, 'x'))).rejects.toThrow(/open shift/)
  })
})

describe('comp (free on purpose)', () => {
  const comp = { code: 'quality-complaint', note: '' }
  it('a ₱40 comp is within the cashier limit: order total ₱0, value kept, queue ticket still made, no payment needed', async () => {
    const c = cartOf(line('a', 4000, 1, { comp }))
    expect(compTotal(c)).toBe(4000)
    const { order, payments } = await payOrder(t1, cashier, c, [], key())
    expect(order).toMatchObject({ total: 0, gross: 0, comps: [{ lineId: 'a', value: 4000, reason: 'quality-complaint' }] })
    expect(payments).toEqual([])
    expect(await db.queueItems.count()).toBe(1) // stock still deducts (3C)
  })
  it('a ₱100 comp is above the ₱50 cashier limit: needs a supervisor PIN, recorded on the order', async () => {
    const c = cartOf(line('a', 10000, 1, { comp }))
    await expect(payOrder(t1, cashier, c, [], key())).rejects.toThrow(/supervisor PIN/)
    const a = await approve({ action: 'comp', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 10000 })
    const { order } = await payOrder(t1, cashier, c, [], key(), undefined, { comp: a.id })
    expect(order.compApprovedBy).toBe(sup)
  })
  it('needs a reason, and "Other" needs a note', async () => {
    await expect(payOrder(t1, cashier, cartOf(line('a', 1000, 1, { comp: { code: '', note: '' } })), [], key())).rejects.toThrow(/Pick a reason/)
    await expect(payOrder(t1, cashier, cartOf(line('a', 1000, 1, { comp: { code: 'other', note: ' ' } })), [], key())).rejects.toThrow(/note/)
  })
  it('only the other lines are charged; a retry with the same key makes no second order', async () => {
    const c = cartOf(line('a', 4000, 1, { comp }), line('b', 8000))
    const k = key()
    const a = await payOrder(t1, cashier, c, cash(8000), k)
    expect(a.order.total).toBe(8000)
    expect((await payOrder(t1, cashier, c, cash(8000), k)).order.id).toBe(a.order.id)
    expect(await db.orders.count()).toBe(1)
  })
  it('a comped line is not discounted again by Senior/PWD', async () => {
    const c = { ...cartOf(line('a', 4000, 1, { comp: { code: 'wrong-order', note: '' } }), line('b', 16800)), discount: { kind: 'senior' as const, name: 'L', idNumber: 'S', signed: true, picks: { a: 1, b: 1 } } }
    const { order } = await payOrder(t1, cashier, c, cash(12000), key())
    expect(order.discount?.lines.map((l) => l.lineId)).toEqual(['b'])
  })
})

describe('remake', () => {
  it('a barista re-makes a ticket: the first is waste, the new one is rushed, no money moves', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    const first = (await db.queueItems.toCollection().first())!
    const copy = await remakeItem(first.id, barista, 'quality-complaint')
    expect(await db.queueItems.get(first.id)).toMatchObject({ status: 'void', wasted: true })
    expect(copy).toMatchObject({ status: 'queued', rush: true, rushReason: 'Remake', remakeOf: first.id })
    expect(await db.remakes.toArray()).toMatchObject([{ itemId: first.id, newItemId: copy.id, userId: barista, reasonCode: 'quality-complaint' }])
    expect(await db.refunds.count()).toBe(0)
    await expect(remakeItem(first.id, barista, 'wrong-order')).rejects.toThrow(/already replaced/)
  })
  it('a cashier cannot remake, and a reason is required', async () => {
    await payOrder(t1, cashier, cartOf(line('a', 10000)), cash(10000), key())
    const first = (await db.queueItems.toCollection().first())!
    await expect(remakeItem(first.id, cashier, 'wrong-order')).rejects.toThrow(/cannot remake/)
    await expect(remakeItem(first.id, barista, '')).rejects.toThrow(/Pick a reason/)
  })
})
