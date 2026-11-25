import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { payCash } from './db/orders'
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
    const { order, payment } = await payCash(t1, 'u1', cart(), 50000, 'k1')
    expect(order.number).toBe(1)
    expect(order.total).toBe(14000)
    expect(payment.tendered - payment.amount).toBe(36000)
    expect(await db.orders.count()).toBe(1)
    expect(await db.auditLog.where('action').equals('order.paid').count()).toBe(1)
  })
  it('stays unpaid when cash is short: nothing saved, no number used', async () => {
    await expect(payCash(t1, 'u1', cart(), 13999, 'k1')).rejects.toThrow(/stays unpaid/)
    expect(await db.orders.count()).toBe(0)
    expect(await db.payments.count()).toBe(0)
  })
  it('the same idempotency key never creates a second order', async () => {
    const a = await payCash(t1, 'u1', cart(), 14000, 'k1')
    const b = await payCash(t1, 'u1', cart(), 14000, 'k1')
    expect(b.order.id).toBe(a.order.id)
    expect(await db.orders.count()).toBe(1)
    expect((await payCash(t1, 'u1', cart(), 14000, 'k2')).order.number).toBe(2)
  })
  it('cannot pay without an open shift', async () => {
    await db.shifts.toCollection().modify({ closedAt: 'x' })
    await expect(payCash(t1, 'u1', cart(), 14000, 'k1')).rejects.toThrow(/open business day and an open shift/)
  })
})
