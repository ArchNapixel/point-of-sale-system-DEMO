import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift, expectedCash } from './db/shifts'
import { setSetting } from './db/settings'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { refundOrder, voidOrder } from './db/refunds'
import { anonymizeCustomer, createCustomer, familyIds, mergeCustomers, searchCustomers } from './db/customers'
import { adjustLoyalty, customerBalance, loyaltyFlags } from './db/loyalty'
import { creditCard, findCards, giftBalance, reissueGiftCard, sellGiftCard } from './db/giftcards'
import { loadReport } from './db/reports'
import { addLine, emptyCart, type Cart, type CartLine } from './lib/cart'
import { balance, earnFor, reversalFor, type Programme } from './lib/loyalty'
import { cardBalance, newCardNumber } from './lib/giftcards'

let t1 = '', cashier = '', sup = '', owner = '', shift = ''
let n = 0
const k = () => `k${++n}`
const line = (id: string, price: number, qty = 1, extra: Partial<CartLine> = {}): CartLine => ({ id, itemId: 'i', variantId: 'v', name: 'Latte ' + id, variantLabel: '', basePrice: price, mods: [], notes: [id], allergy: '', qty, ...extra })
const cartOf = (...ls: CartLine[]): Cart => ls.reduce(addLine, emptyCart())
const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]
const bal = async (id: string) => (await customerBalance(id)).balance
const mkCustomer = (name = 'Joy', phone = '09171234567') => createCustomer({ name, phone, consent: true, userId: cashier })

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = (await createBranch('Main')).id
  t1 = (await createTerminal(b, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  owner = (await createUser('Boss', 'owner', '3333')).id
  await openBusinessDay(b, sup)
  shift = (await openShift(t1, cashier, { b1000: 2 })).id
})

const P: Programme = { mode: 'stamps', rewardAt: 9, pesosPerPoint: 10, expiryDays: 365, warnDays: 30 }

describe('earning rules', () => {
  it('stamps: one per drink paid for; free and reward drinks earn nothing', () => {
    expect(earnFor(P, [{ qty: 2, free: false }, { qty: 1, free: true }], 99999)).toBe(2)
  })
  it('points: one per ₱10 actually paid, rounded down; off earns nothing', () => {
    expect(earnFor({ ...P, mode: 'points' }, [], 16799)).toBe(16) // ₱167.99 → 16
    expect(earnFor({ ...P, mode: 'off' }, [{ qty: 5, free: false }], 50000)).toBe(0)
  })
  it('reversal: the share refunded of what the order earned, never more than is left', () => {
    expect(reversalFor(3, 0, 10000, 30000, false)).toBe(1)
    expect(reversalFor(3, 1, 20000, 30000, false)).toBe(2) // 2 left, 2 due
    expect(reversalFor(3, 0, 1, 30000, true)).toBe(3)
    expect(reversalFor(3, 3, 30000, 30000, true)).toBe(0)
  })
  it('expiry: oldest used first; old points are gone; the warning lists what goes soon', () => {
    const day = 86_400_000
    const now = new Date('2026-11-25T12:00:00Z')
    const ago = (d: number) => new Date(now.getTime() - d * day).toISOString()
    const r = balance([{ amount: 10, at: ago(400) }, { amount: 5, at: ago(340) }, { amount: 4, at: ago(10) }, { amount: -3, at: ago(5) }], now, 365, 30)
    // the 400-day-old lot is used first (3 of 10), then expires with the rest; 5 left from 340 days ago, 4 from 10 days ago
    expect(r.balance).toBe(9)
    expect(r.expiringSoon).toEqual([{ amount: 5, expiresAt: new Date(now.getTime() - 340 * day + 365 * day).toISOString() }])
    expect(balance([{ amount: 5, at: ago(900) }], now, 0, 30).balance).toBe(5) // 0 = never
  })
})

describe('customers and consent', () => {
  it('a profile is saved only with consent; a number already used is refused', async () => {
    await expect(createCustomer({ name: 'Joy', consent: false, userId: cashier })).rejects.toThrow(/consent/)
    await mkCustomer()
    await expect(mkCustomer('Other', '0917 123 4567')).rejects.toThrow(/already has a profile/)
    await expect(createCustomer({ name: 'X', phone: '123', consent: true, userId: cashier })).rejects.toThrow(/full mobile/)
  })
  it('find by part of the name or the last 4 digits', async () => {
    const joy = await mkCustomer()
    await mkCustomer('Mark', '09998887777')
    expect((await searchCustomers('joy')).map((c) => c.id)).toEqual([joy.id])
    expect((await searchCustomers('4567')).map((c) => c.id)).toEqual([joy.id])
    expect(await searchCustomers('45')).toEqual([]) // not 4 digits
  })
  it('merging keeps all history: the balance of both profiles follows the survivor', async () => {
    await setSetting('loyaltyMode', 'stamps')
    const old = await mkCustomer('Joy', '09171234567')
    const fresh = await mkCustomer('Joy new SIM', '09170000000')
    await payOrder(t1, cashier, { ...cartOf(line('a', 10000, 2)), customerId: old.id }, cash(20000), k())
    await payOrder(t1, cashier, { ...cartOf(line('b', 10000)), customerId: fresh.id }, cash(10000), k())
    await mergeCustomers(fresh.id, old.id, sup)
    expect(await familyIds(fresh.id)).toEqual(expect.arrayContaining([fresh.id, old.id]))
    expect(await bal(fresh.id)).toBe(3)
    expect((await searchCustomers('joy')).map((c) => c.id)).toEqual([fresh.id]) // the old profile is gone from search
  })
  it('"remove my info": name and number go, sales and stamps stay without personal details', async () => {
    await setSetting('loyaltyMode', 'stamps')
    const joy = await mkCustomer()
    const { order } = await payOrder(t1, cashier, { ...cartOf(line('a', 10000)), name: 'Joy', customerId: joy.id }, cash(10000), k())
    await anonymizeCustomer(joy.id, owner)
    expect(await db.customers.get(joy.id)).toMatchObject({ name: 'Deleted customer', active: false })
    expect((await db.customers.get(joy.id))?.phone).toBeUndefined()
    expect(await db.orders.get(order.id)).toMatchObject({ name: '', total: 10000 })
    expect(await bal(joy.id)).toBe(1) // history kept
    expect(await searchCustomers('Deleted')).toEqual([])
  })
})

describe('loyalty on sales', () => {
  it('earns stamps on a paid order, only when a customer is on it and loyalty is on', async () => {
    const joy = await mkCustomer()
    await payOrder(t1, cashier, { ...cartOf(line('a', 10000)), customerId: joy.id }, cash(10000), k())
    expect(await bal(joy.id)).toBe(0) // off
    await setSetting('loyaltyMode', 'stamps')
    const r = await payOrder(t1, cashier, { ...cartOf(line('b', 10000, 3)), customerId: joy.id }, cash(30000), k())
    expect(r.earned).toBe(3)
    expect(await bal(joy.id)).toBe(3)
    await payOrder(t1, cashier, cartOf(line('c', 10000)), cash(10000), k()) // no customer
    expect(await bal(joy.id)).toBe(3)
  })
  it('points are earned on the amount actually paid, after a discount, not on the delivery fee', async () => {
    await setSetting('loyaltyMode', 'points')
    const joy = await mkCustomer()
    const senior = { kind: 'senior' as const, name: 'Lola', idNumber: 'S1', signed: true, picks: { a: 1 } }
    await payOrder(t1, cashier, { ...cartOf(line('a', 16800)), discount: senior, customerId: joy.id, deliveryFee: 9000 }, cash(21000), k()) // pays ₱120 + fee
    expect(await bal(joy.id)).toBe(12) // ₱120 / ₱10
  })
  it('the 10th drink is free: a reward needs the stamps, costs them, is a ₱0 line, and the stock/cost shows as loyalty, not a comp', async () => {
    await setSetting('loyaltyMode', 'stamps')
    const joy = await mkCustomer()
    const reward = (id: string) => ({ ...cartOf(line(id, 16800, 1, { comp: { code: 'loyalty-reward', note: '' } })), customerId: joy.id })
    await expect(payOrder(t1, cashier, { ...reward('r'), customerId: undefined }, [], k())).rejects.toThrow(/needs a customer/)
    await expect(payOrder(t1, cashier, reward('r'), [], k())).rejects.toThrow(/has 0 of the 9 stamps needed/)
    for (let i = 0; i < 3; i++) await payOrder(t1, cashier, { ...cartOf(line('b' + i, 10000, 3)), customerId: joy.id }, cash(30000), k()) // 9 stamps
    expect(await bal(joy.id)).toBe(9)
    const { order } = await payOrder(t1, cashier, reward('r'), [], k()) // ₱168 free: no comp limit or PIN
    expect(order).toMatchObject({ total: 0, comps: [{ reason: 'loyalty-reward', value: 16800 }] })
    expect(await bal(joy.id)).toBe(0) // the free drink earned no stamp
    const rep = await loadReport({ kind: 'shift', shiftId: shift })
    expect(rep.loyaltyRewards).toEqual({ count: 1, value: 16800 })
    expect(rep.comps).toEqual({ count: 0, value: 0 })
  })
  it('a refund takes back the stamps in proportion; a void takes all of them back', async () => {
    await setSetting('loyaltyMode', 'stamps')
    const joy = await mkCustomer()
    const { order } = await payOrder(t1, cashier, { ...cartOf(line('a', 10000), line('b', 10000), line('c', 10000)), customerId: joy.id }, cash(30000), k())
    expect(await bal(joy.id)).toBe(3)
    await db.queueItems.toCollection().modify({ status: 'served' })
    const pin = (amount: number) => approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount, ref: order.id })
    await refundOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: (await pin(10000)).id, idempotencyKey: k(), picks: { a: 1 }, method: 'cash' })
    expect(await bal(joy.id)).toBe(2)
    const o2 = (await payOrder(t1, cashier, { ...cartOf(line('d', 10000, 2)), customerId: joy.id }, cash(20000), k())).order
    expect(await bal(joy.id)).toBe(4)
    const a = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 20000, ref: o2.id })
    await voidOrder({ orderId: o2.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })
    expect(await bal(joy.id)).toBe(2)
  })
  it('stamps added by hand need a reason and a supervisor PIN, and are flagged', async () => {
    const joy = await mkCustomer()
    await expect(adjustLoyalty({ customerId: joy.id, amount: 5, reason: ' ', userId: cashier })).rejects.toThrow(/reason/)
    await expect(adjustLoyalty({ customerId: joy.id, amount: 5, reason: 'Forgot to ring', userId: cashier })).rejects.toThrow(/supervisor PIN/)
    const a = await approve({ action: 'loyalty', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 5, ref: joy.id })
    await adjustLoyalty({ customerId: joy.id, amount: 5, reason: 'Forgot to ring', userId: cashier, approvalId: a.id })
    expect(await bal(joy.id)).toBe(5)
    expect((await loyaltyFlags()).adjustments).toMatchObject([{ amount: 5, name: 'Joy', approvedBy: sup }])
  })
  it('flags a customer earning from many orders in a day, and a profile named like a staff member', async () => {
    await setSetting('loyaltyMode', 'stamps')
    await setSetting('loyaltyFastEarnPerDay', 2)
    const ana = await createUser('Ana', 'barista', '4444')
    const prof = await mkCustomer('Ana', '09175550000')
    for (let i = 0; i < 3; i++) await payOrder(t1, cashier, { ...cartOf(line('x' + i, 10000)), customerId: prof.id }, cash(10000), k())
    const f = await loyaltyFlags()
    expect(f.fast).toMatchObject([{ name: 'Ana', orders: 3 }])
    expect(f.staffProfiles.map((s) => s.name)).toEqual(['Ana'])
    expect(ana.id).toBeTruthy()
  })
})

describe('gift cards', () => {
  it('numbers are readable and balances add up', () => {
    expect(newCardNumber()).toMatch(/^GC-\d{4}-\d{4}$/)
    expect(cardBalance([{ amount: 100000 }, { amount: -18500 }])).toBe(81500)
  })
  it('selling one is a liability, not a sale: cash goes in the drawer, net sales stay 0, the amount shows as on cards', async () => {
    const before = await expectedCash(shift)
    const card = await sellGiftCard({ terminalId: t1, userId: cashier, amount: 100000, method: 'cash' })
    expect(card.number).toMatch(/^GC-/)
    expect(await giftBalance(card.id)).toBe(100000)
    expect(await expectedCash(shift)).toBe(before + 100000)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ net: 0, gross: 0, giftCards: { sold: 100000, redeemed: 0, outstanding: 100000 } })
  })
  it('checks the sale: amount, how it was paid, a reference for non-cash', async () => {
    await expect(sellGiftCard({ terminalId: t1, userId: cashier, amount: 0, method: 'cash' })).rejects.toThrow(/amount/)
    await expect(sellGiftCard({ terminalId: t1, userId: cashier, amount: 100, method: 'gcash' })).rejects.toThrow(/reference/)
    await expect(sellGiftCard({ terminalId: t1, userId: cashier, amount: 100, method: 'platform' as never })).rejects.toThrow(/how it was paid/)
    await db.shifts.update(shift, { closedAt: 'x' })
    await expect(sellGiftCard({ terminalId: t1, userId: cashier, amount: 100, method: 'cash' })).rejects.toThrow(/open shift/)
  })
  it('partial use: ₱1,000 card, ₱185 order → ₱815 left, in parts, never below zero', async () => {
    const card = await sellGiftCard({ terminalId: t1, userId: cashier, amount: 100000, method: 'cash' })
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 18500)), [{ method: 'giftcard', amount: 18500, reference: card.number }], k())
    expect(await giftBalance(card.id)).toBe(81500)
    expect((await db.giftCardTx.where('orderId').equals(order.id).first())?.balanceAfter).toBe(81500) // printed on the receipt
    await payOrder(t1, cashier, cartOf(line('b', 18500)), [{ method: 'giftcard', amount: 18500, reference: card.number.toLowerCase() }], k()) // the same card again
    expect(await giftBalance(card.id)).toBe(63000)
    await expect(payOrder(t1, cashier, cartOf(line('c', 70000)), [{ method: 'giftcard', amount: 70000, reference: card.number }], k())).rejects.toThrow(/only ₱630.00 left/)
    await payOrder(t1, cashier, cartOf(line('c', 70000)), [{ method: 'giftcard', amount: 63000, reference: card.number }, { method: 'cash', tendered: 7000 }], k()) // card + cash
    expect(await giftBalance(card.id)).toBe(0)
    await expect(payOrder(t1, cashier, cartOf(line('d', 100)), [{ method: 'giftcard', amount: 100, reference: 'GC-0000-0000' }], k())).rejects.toThrow(/No gift card/)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.giftCards).toMatchObject({ sold: 100000, redeemed: 100000, outstanding: 0 })
    expect(r.payments.giftcard.collected).toBe(100000)
  })
  it('voiding a sale paid with a card, or refunding to it, puts the money back on the card', async () => {
    const card = await sellGiftCard({ terminalId: t1, userId: cashier, amount: 50000, method: 'cash' })
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 20000)), [{ method: 'giftcard', amount: 20000, reference: card.number }], k())
    const a = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 20000, ref: order.id })
    await voidOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })
    expect(await giftBalance(card.id)).toBe(50000)
    const o2 = (await payOrder(t1, cashier, cartOf(line('b', 10000)), cash(10000), k())).order
    await db.queueItems.toCollection().modify({ status: 'served' })
    const p2 = await approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 10000, ref: o2.id })
    await expect(refundOrder({ orderId: o2.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: p2.id, idempotencyKey: k(), picks: { b: 1 }, method: 'giftcard' })).rejects.toThrow(/gift card number/)
    const p3 = await approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 10000, ref: o2.id })
    await refundOrder({ orderId: o2.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: p3.id, idempotencyKey: k(), picks: { b: 1 }, method: 'giftcard', reference: card.number })
    expect(await giftBalance(card.id)).toBe(60000)
  })
  it('a lost card: find it by number or buyer, the owner reissues the balance on a new card, the old number stops', async () => {
    const joy = await mkCustomer()
    const card = await sellGiftCard({ terminalId: t1, userId: cashier, amount: 100000, method: 'cash', buyerId: joy.id })
    await payOrder(t1, cashier, cartOf(line('a', 18500)), [{ method: 'giftcard', amount: 18500, reference: card.number }], k())
    expect((await findCards('joy'))[0]).toMatchObject({ number: card.number, balance: 81500, buyer: 'Joy' })
    expect((await findCards(card.number.slice(3, 7))).length).toBe(1)
    await expect(reissueGiftCard(card.id, sup)).rejects.toThrow(/Only the owner/)
    const fresh = await reissueGiftCard(card.id, owner)
    expect(await giftBalance(fresh.id)).toBe(81500)
    expect(await giftBalance(card.id)).toBe(0)
    await expect(payOrder(t1, cashier, cartOf(line('b', 100)), [{ method: 'giftcard', amount: 100, reference: card.number }], k())).rejects.toThrow(/replaced/)
    await creditCard(card.number, 500, 'o', cashier) // a late refund to the lost card lands on the new one
    expect(await giftBalance(fresh.id)).toBe(82000)
  })
})
