import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { setSetting } from './db/settings'
import { approve } from './db/approvals'
import { logPrint, payOrder } from './db/orders'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import { canApprove, needsApproval } from './lib/approval'

const LIMITS = { discountCashier: 30000, discountSupervisor: 200000, compCashier: 5000, compSupervisor: 100000 }
let t1 = ''
let cashier = '', sup = '', owner = ''

const latte = (qty = 1, price = 16800): CartLine => ({
  id: 'a', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '16 oz', basePrice: price, mods: [], notes: [], allergy: '', qty,
})
// A senior discount on the whole cart. 10 lattes at ₱168: reduction ₱480 (VAT café), above the ₱300 cashier limit.
const bigDiscountCart = () => ({
  ...addLine(emptyCart(), latte(10)),
  discount: { kind: 'senior' as const, name: 'Lola', idNumber: 'SC1', signed: true, picks: { a: 10 } },
})
const smallDiscountCart = () => ({ ...addLine(emptyCart(), latte(1)), discount: { kind: 'senior' as const, name: 'Lola', idNumber: 'SC2', signed: true, picks: { a: 1 } } })
const cash = (n: number) => [{ method: 'cash' as const, tendered: n }]

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  owner = (await createUser('Boss', 'owner', '3333')).id
  await openBusinessDay(b.id, 'sup')
  await openShift(t1, cashier, { b1000: 2 })
})

describe('who needs approval', () => {
  it('a cashier is alone within the limit and needs approval above it; the owner has no limit', () => {
    expect(needsApproval('cashier', 'discount', 30000, LIMITS)).toBe(false)
    expect(needsApproval('cashier', 'discount', 30001, LIMITS)).toBe(true)
    expect(needsApproval('supervisor', 'discount', 30001, LIMITS)).toBe(false)
    expect(needsApproval('supervisor', 'discount', 200001, LIMITS)).toBe(true)
    expect(needsApproval('owner', 'discount', 99999999, LIMITS)).toBe(false)
  })
  it('an approver must hold the permission and have a limit that covers the amount', () => {
    expect(canApprove('cashier', 'discount', 100, LIMITS)).toBe(false)
    expect(canApprove('supervisor', 'discount', 200000, LIMITS)).toBe(true)
    expect(canApprove('supervisor', 'discount', 200001, LIMITS)).toBe(false)
    expect(canApprove('owner', 'discount', 200001, LIMITS)).toBe(true)
  })
  it('only cashiers (without the permission) need approval to reprint', () => {
    expect(needsApproval('cashier', 'reprint', 0, LIMITS)).toBe(true)
    expect(needsApproval('supervisor', 'reprint', 0, LIMITS)).toBe(false)
  })
})

describe('approve()', () => {
  const ask = (approverId: string, pin: string, extra = {}) =>
    approve({ action: 'discount', requesterId: cashier, approverId, pin, terminalId: t1, amount: 48000, ...extra })

  it('records who, which terminal and when, for a correct personal PIN', async () => {
    const a = await ask(sup, '2222')
    expect(a).toMatchObject({ requesterId: cashier, approverId: sup, terminalId: t1, amount: 48000, selfApproved: false })
    expect(a.at).toBeTruthy()
    expect(await db.auditLog.where('action').equals('approval.discount').count()).toBe(1)
  })
  it('a wrong PIN, or someone else’s PIN, is refused and logged', async () => {
    await expect(ask(sup, '9999')).rejects.toThrow(/Wrong PIN/)
    await expect(ask(sup, '1111')).rejects.toThrow(/Wrong PIN/)
    expect(await db.approvals.count()).toBe(0)
    expect(await db.auditLog.where('action').equals('approval.failed').count()).toBe(2)
  })
  it('a cashier cannot approve, and a supervisor cannot approve past their limit', async () => {
    await expect(ask(cashier, '1111')).rejects.toThrow(/cannot approve/)
    await expect(ask(sup, '2222', { amount: 200001 })).rejects.toThrow(/cannot approve/)
    expect((await ask(owner, '3333', { amount: 200001 })).approverId).toBe(owner)
  })
  it('approving your own action is allowed but flagged', async () => {
    const a = await approve({ action: 'reprint', requesterId: sup, approverId: sup, pin: '2222', terminalId: t1 })
    expect(a.selfApproved).toBe(true)
  })
})

describe('enforced where the action happens', () => {
  it('a discount within the limit needs no approval', async () => {
    const { order } = await payOrder(t1, cashier, smallDiscountCart(), cash(20000), 'k1')
    expect(order.discountApprovedBy).toBeUndefined()
  })
  it('a big discount cannot be saved without a supervisor approval, and nothing is saved', async () => {
    await expect(payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k1')).rejects.toThrow(/supervisor PIN/)
    expect(await db.orders.count()).toBe(0)
  })
  it('with a valid approval it saves, records the approver, and the approval is good once', async () => {
    const a = await approve({ action: 'discount', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 48000 })
    const { order } = await payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k1', undefined, { discount: a.id })
    expect(order.discountApprovedBy).toBe(sup)
    expect((await db.approvals.get(a.id))?.usedFor).toBe(order.id)
    await expect(payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k2', undefined, { discount: a.id })).rejects.toThrow(/supervisor PIN/)
  })
  it('an approval for a smaller amount, or for someone else, does not cover it', async () => {
    const small = await approve({ action: 'discount', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 31000 })
    await expect(payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k1', undefined, { discount: small.id })).rejects.toThrow(/supervisor PIN/)
    const theirs = await approve({ action: 'discount', requesterId: sup, approverId: owner, pin: '3333', terminalId: t1, amount: 48000 })
    await expect(payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k2', undefined, { discount: theirs.id })).rejects.toThrow(/supervisor PIN/)
  })
  it('the limit is a setting', async () => {
    await setSetting('cashierDiscountLimitCentavos', 50000)
    expect((await payOrder(t1, cashier, bigDiscountCart(), cash(200000), 'k1')).order.discountApprovedBy).toBeUndefined()
  })
  it('a cashier reprint needs a supervisor PIN, once per reprint; a supervisor does not', async () => {
    const { order } = await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), 'k1')
    expect(await logPrint(order.id, cashier)).toBe('original') // the first print is free
    await expect(logPrint(order.id, cashier)).rejects.toThrow(/supervisor PIN/)
    const a = await approve({ action: 'reprint', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, ref: order.id })
    expect(await logPrint(order.id, cashier, a.id)).toBe('reprint')
    await expect(logPrint(order.id, cashier, a.id)).rejects.toThrow(/supervisor PIN/)
    expect(await logPrint(order.id, sup)).toBe('reprint')
    expect((await db.invoicePrints.filter((p) => p.kind === 'reprint').toArray()).map((p) => p.approvedBy).filter(Boolean)).toEqual([sup])
  })
})
