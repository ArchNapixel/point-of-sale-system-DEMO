import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { payOrder, verifyPayment } from './db/orders'
import { applyLines } from './lib/payments'
import { addLine, emptyCart, type CartLine } from './lib/cart'

let t1 = ''
const latte: CartLine = {
  id: 'l1', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '16 oz', basePrice: 14000, mods: [], notes: [], allergy: '', qty: 1,
}
const cart = () => ({ ...addLine(emptyCart(), latte), name: 'Mark' })

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const branch = await createBranch('Main')
  t1 = (await createTerminal(branch.id, 'Counter 1', 'T1')).id
  await openBusinessDay(branch.id, 'sup')
  await openShift(t1, 'u1', { b1000: 2 })
})

describe('cash payment', () => {
  it('pays ₱140 with ₱500 → change ₱360, order number 1, paid order saved', async () => {
    const { order, payments, change } = await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 50000 }], 'k1')
    expect(order.number).toBe(1)
    expect(order.total).toBe(14000)
    expect(change).toBe(36000)
    expect(payments[0].status).toBe('verified')
    expect(await db.orders.count()).toBe(1)
    expect(await db.auditLog.where('action').equals('order.paid').count()).toBe(1)
  })
  it('stays unpaid when cash is short: nothing saved, no number used', async () => {
    await expect(payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 13999 }], 'k1')).rejects.toThrow(/stays unpaid/)
    expect(await db.orders.count()).toBe(0)
    expect(await db.payments.count()).toBe(0)
  })
  it('the same idempotency key never creates a second order', async () => {
    const a = await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 14000 }], 'k1')
    const b = await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 14000 }], 'k1')
    expect(b.order.id).toBe(a.order.id)
    expect(await db.orders.count()).toBe(1)
    expect((await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 14000 }], 'k2')).order.number).toBe(2)
  })
  it('cannot pay without an open shift', async () => {
    await db.shifts.toCollection().modify({ closedAt: 'x' })
    await expect(payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 14000 }], 'k1')).rejects.toThrow(/open business day and an open shift/)
  })
})

describe('other payments and split tender', () => {
  it('GCash is saved pending, a supervisor verifies it, and the audit notes self-approval', async () => {
    const { payments } = await payOrder(t1, 'u1', cart(), [{ method: 'gcash', amount: 14000, reference: ' 1234567890123 ' }], 'k1')
    expect(payments[0]).toMatchObject({ status: 'pending', reference: '1234567890123' })
    await verifyPayment(payments[0].id, 'u1')
    expect((await db.payments.get(payments[0].id))?.status).toBe('verified')
    expect((await db.auditLog.where('action').equals('payment.verified').first())?.detail?.selfApproved).toBe(true)
  })
  it('rejects a GCash/Maya reference that was already used, saving nothing', async () => {
    await payOrder(t1, 'u1', cart(), [{ method: 'gcash', amount: 14000, reference: 'ABC123' }], 'k1')
    await expect(payOrder(t1, 'u1', cart(), [{ method: 'maya', amount: 14000, reference: 'abc123' }], 'k2')).rejects.toThrow(/already used/)
    expect(await db.orders.count()).toBe(1)
  })
  it('card needs an approval code and exactly 4 digits', () => {
    expect(() => applyLines(14000, [{ method: 'card', amount: 14000, last4: '1234' }])).toThrow(/approval code/)
    expect(() => applyLines(14000, [{ method: 'card', amount: 14000, approvalCode: 'A1', last4: '12' }])).toThrow(/last 4/)
    expect(applyLines(14000, [{ method: 'card', amount: 14000, approvalCode: 'A1', last4: '1234' }]).applied[0].status).toBe('verified')
  })
  it('₱150 e-wallet on ₱185 leaves ₱35 for cash; change only on the last cash line', () => {
    const r = applyLines(18500, [{ method: 'gcash', amount: 15000, reference: 'R1' }, { method: 'cash', tendered: 10000 }])
    expect(r.remaining).toBe(0)
    expect(r.change).toBe(6500)
    expect(applyLines(18500, [{ method: 'gcash', amount: 15000, reference: 'R1' }]).remaining).toBe(3500)
  })
  it('does not accept an e-wallet overpayment', () => {
    expect(() => applyLines(14000, [{ method: 'maya', amount: 15000, reference: 'R1' }])).toThrow(/refunded/)
  })
  it('split ₱100 cash + ₱40 GCash pays the order; a partial set leaves it unpaid', async () => {
    const lines = [{ method: 'cash' as const, tendered: 10000 }, { method: 'gcash' as const, amount: 4000, reference: 'R9' }]
    await expect(payOrder(t1, 'u1', cart(), lines.slice(0, 1), 'k1')).rejects.toThrow(/₱40.00 still to pay/)
    expect(await db.orders.count()).toBe(0)
    const { payments } = await payOrder(t1, 'u1', cart(), lines, 'k2')
    expect(payments.map((p) => p.amount)).toEqual([10000, 4000])
  })
})
