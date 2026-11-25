import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { closeShift, expectedCash, expectedFloat, getCloseSummary, getSellContext, openBusinessDay, openShift, submitCloseCount } from './db/shifts'
import { payOrder } from './db/orders'
import { holdCart } from './db/carts'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import { overShortStatus } from './lib/cash'

let t1 = ''
let shiftId = ''
const OPEN = { b1000: 2 } // ₱2,000 float

const latte = (price = 16800): CartLine => ({
  id: 'a', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '16 oz', basePrice: price, mods: [], notes: [], allergy: '', qty: 1,
})
const cart = (price?: number) => addLine(emptyCart(), latte(price))

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  await openBusinessDay(b.id, 'sup')
  shiftId = (await openShift(t1, 'u1', OPEN)).id
})

describe('expected cash', () => {
  it('is the opening count plus cash sales: change given back and GCash do not count', async () => {
    await payOrder(t1, 'u1', cart(10000), [{ method: 'cash', tendered: 50000 }], 'k1') // ₱100 sale, ₱500 handed over, ₱400 change
    await payOrder(t1, 'u1', cart(8000), [{ method: 'gcash', amount: 8000, reference: 'R1' }], 'k2')
    await payOrder(t1, 'u1', cart(6000), [{ method: 'cash', tendered: 2000 }, { method: 'gcash', amount: 4000, reference: 'R2' }], 'k3')
    expect(await expectedCash(shiftId)).toBe(200000 + 10000 + 2000)
  })
  it('over/short is inclusive of the tolerance', () => {
    expect(overShortStatus(9980, 10000, 2000)).toEqual({ diff: -20, within: true })
    expect(overShortStatus(7999, 10000, 2000)).toEqual({ diff: -2001, within: false })
  })
})

describe('closing a shift', () => {
  it('shows nothing until a count is submitted, then expected vs counted', async () => {
    expect(await getCloseSummary(shiftId)).toBeNull()
    await payOrder(t1, 'u1', cart(10000), [{ method: 'cash', tendered: 10000 }], 'k1')
    await submitCloseCount(shiftId, 'u1', { b1000: 2, b100: 1 })
    expect(await getCloseSummary(shiftId)).toMatchObject({ expected: 210000, counted: 210000, diff: 0, within: true, attempts: 1 })
  })
  it('a ₱30 short is past the ₱20 tolerance: it needs a note to close', async () => {
    await submitCloseCount(shiftId, 'u1', { b1000: 1, b500: 1, b200: 2, b50: 1, b20: 1 }) // ₱1,970
    expect(await getCloseSummary(shiftId)).toMatchObject({ diff: -3000, within: false })
    await expect(closeShift(shiftId, 'u1')).rejects.toThrow(/Add a note/)
    await closeShift(shiftId, 'u1', 'Gave change for a ₱500 twice')
    expect(await db.shifts.get(shiftId)).toMatchObject({ overShort: -3000, overShortNote: 'Gave change for a ₱500 twice', closeCounted: 197000 })
  })
  it('an exact count closes without a note, logs it, and ends selling', async () => {
    await submitCloseCount(shiftId, 'u1', { b1000: 2 })
    await closeShift(shiftId, 'u1')
    expect(await getSellContext(t1)).toBeNull()
    expect(await db.auditLog.where('action').equals('shift.close').count()).toBe(1)
  })
  it('allows one recount and keeps both counts', async () => {
    await submitCloseCount(shiftId, 'u1', { b1000: 1 })
    await submitCloseCount(shiftId, 'u1', { b1000: 2 })
    await expect(submitCloseCount(shiftId, 'u1', { b1000: 2 })).rejects.toThrow(/One recount only/)
    expect(await db.cashCounts.where('shiftId').equals(shiftId).filter((c) => c.kind === 'close').count()).toBe(2)
    const s = (await getCloseSummary(shiftId))!
    expect(s).toMatchObject({ counted: 200000, attempts: 2, counts: [100000, 200000], within: true })
  })
  it('the drawer total is left for the next opener', async () => {
    await submitCloseCount(shiftId, 'u1', { b1000: 2, b500: 1 })
    await closeShift(shiftId, 'u1', 'Extra ₱500, customer left it')
    expect(await expectedFloat(t1)).toEqual({ amount: 250000, source: 'last-close' })
  })
  it('only the cashier who opened the shift can close it', async () => {
    await expect(submitCloseCount(shiftId, 'other', { b1000: 2 })).rejects.toThrow(/Only the cashier/)
    await submitCloseCount(shiftId, 'u1', { b1000: 2 })
    await expect(closeShift(shiftId, 'other')).rejects.toThrow(/Only the cashier/)
  })
  it('cannot close without counting, and flags held carts and pending GCash without blocking', async () => {
    await expect(closeShift(shiftId, 'u1')).rejects.toThrow(/Count the drawer/)
    await holdCart(t1, shiftId, 'u1', cart())
    await payOrder(t1, 'u1', cart(10000), [{ method: 'gcash', amount: 10000, reference: 'R1' }], 'k1')
    await submitCloseCount(shiftId, 'u1', { b1000: 2 })
    expect(await getCloseSummary(shiftId)).toMatchObject({ heldCarts: 1, pendingPayments: 1 })
    await closeShift(shiftId, 'u1')
    expect((await db.shifts.get(shiftId))?.closedAt).toBeTruthy()
  })
})
