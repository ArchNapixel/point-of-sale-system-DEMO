import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { closeShift, expectedCash, openBusinessDay, openShift, submitCloseCount } from './db/shifts'
import { approve } from './db/approvals'
import { recordCash } from './db/cash'
import { payOrder } from './db/orders'
import { addLine, emptyCart } from './lib/cart'
import { cashEffect } from './lib/cash'

let t1 = ''
let shiftId = ''
let cashier = '', sup = ''
let n = 0
const key = () => `c${++n}`

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  await openBusinessDay(b.id, sup)
  shiftId = (await openShift(t1, cashier, { b1000: 2 })).id // ₱2,000
})

const ok = async (kind: 'drop' | 'paid-out' | 'paid-in' | 'no-sale', amount: number, extra = {}) => {
  const a = await approve({ action: 'cash', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount, ref: shiftId })
  return recordCash({ shiftId, userId: cashier, kind, amount, reason: 'because', approvalId: a.id, idempotencyKey: key(), ...extra })
}

describe('cash movements', () => {
  it('expected drawer cash includes them: paid-in up, paid-out and drop down, no-sale no change', async () => {
    expect(await expectedCash(shiftId)).toBe(200000)
    await ok('paid-in', 50000) // coins from the safe
    await ok('paid-out', 30000) // grocery run
    await ok('drop', 100000)
    await ok('no-sale', 0)
    expect(await expectedCash(shiftId)).toBe(200000 + 50000 - 30000 - 100000)
    expect(cashEffect('drop', 100)).toBe(-100)
    expect(cashEffect('no-sale', 0)).toBe(0)
  })
  it('combines with sales: the blind count at close matches the new expected cash', async () => {
    await payOrder(t1, cashier, addLine(emptyCart(), { id: 'a', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '', basePrice: 10000, mods: [], notes: [], allergy: '', qty: 1 }), [{ method: 'cash', tendered: 10000 }], key())
    await ok('drop', 100000)
    await submitCloseCount(shiftId, cashier, { b1000: 1, b100: 1 }) // 2,000 + 100 sale - 1,000 drop = ₱1,100
    const closed = await closeShift(shiftId, cashier)
    expect(closed).toMatchObject({ expected: 110000, diff: 0 })
  })
  it('needs a supervisor PIN and a reason, and records who approved, when and which terminal', async () => {
    await expect(recordCash({ shiftId, userId: cashier, kind: 'drop', amount: 1000, reason: 'x', idempotencyKey: key() })).rejects.toThrow(/supervisor PIN/)
    const a = await approve({ action: 'cash', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 1000, ref: shiftId })
    await expect(recordCash({ shiftId, userId: cashier, kind: 'drop', amount: 1000, reason: ' ', approvalId: a.id, idempotencyKey: key() })).rejects.toThrow(/reason/)
    const m = await recordCash({ shiftId, userId: cashier, kind: 'drop', amount: 1000, reason: 'Over the limit', approvalId: a.id, idempotencyKey: key() })
    expect(m).toMatchObject({ approvedBy: sup, userId: cashier, terminalId: t1, reason: 'Over the limit' })
    expect(await db.auditLog.where('action').equals('cash.drop').count()).toBe(1)
  })
  it('an approval is for one movement and one amount, on that shift', async () => {
    const a = await approve({ action: 'cash', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 1000, ref: shiftId })
    await recordCash({ shiftId, userId: cashier, kind: 'paid-out', amount: 1000, reason: 'milk', approvalId: a.id, idempotencyKey: key() })
    await expect(recordCash({ shiftId, userId: cashier, kind: 'paid-out', amount: 1000, reason: 'milk', approvalId: a.id, idempotencyKey: key() })).rejects.toThrow(/supervisor PIN/)
    const small = await approve({ action: 'cash', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 500, ref: shiftId })
    await expect(recordCash({ shiftId, userId: cashier, kind: 'paid-out', amount: 1000, reason: 'milk', approvalId: small.id, idempotencyKey: key() })).rejects.toThrow(/supervisor PIN/)
  })
  it('money out cannot exceed the drawer, and a no-sale moves no money', async () => {
    await expect(ok('paid-out', 200001)).rejects.toThrow(/more than the drawer/)
    await expect(ok('no-sale', 100)).rejects.toThrow(/no money/)
    await expect(ok('paid-in', 0)).rejects.toThrow(/amount/)
  })
  it('only the drawer owner records it, only on an open shift, and a repeated tap saves once', async () => {
    const a = await approve({ action: 'cash', requesterId: sup, approverId: sup, pin: '2222', terminalId: t1, amount: 1000, ref: shiftId })
    await expect(recordCash({ shiftId, userId: sup, kind: 'drop', amount: 1000, reason: 'x', approvalId: a.id, idempotencyKey: key() })).rejects.toThrow(/owns this drawer/)
    const k = key()
    const b = await approve({ action: 'cash', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 1000, ref: shiftId })
    const first = await recordCash({ shiftId, userId: cashier, kind: 'drop', amount: 1000, reason: 'x', approvalId: b.id, idempotencyKey: k })
    expect((await recordCash({ shiftId, userId: cashier, kind: 'drop', amount: 1000, reason: 'x', idempotencyKey: k })).id).toBe(first.id)
    expect(await db.cashMovements.count()).toBe(1)
    await db.shifts.update(shiftId, { closedAt: 'x' })
    await expect(ok('paid-in', 100)).rejects.toThrow(/not open/)
  })
  it('a no-sale open is always logged with its approver', async () => {
    await ok('no-sale', 0)
    expect(await db.auditLog.where('action').equals('cash.no-sale').count()).toBe(1)
    expect(await db.cashMovements.toArray()).toMatchObject([{ kind: 'no-sale', amount: 0, approvedBy: sup }])
  })
})
