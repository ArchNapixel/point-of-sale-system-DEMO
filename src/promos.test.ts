import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { setSetting } from './db/settings'
import { payOrder } from './db/orders'
import { checkCode, createPromo, setPromoActive } from './db/promos'
import { refundableLines } from './db/refunds'
import { addLine, changeQty, emptyCart, type Cart, type CartLine } from './lib/cart'
import { priceCart } from './lib/discount'
import { invoiceFigures } from './lib/invoice'
import { bestPromo, inWindow, promoReduction, type Promo } from './lib/promos'

const line = (id: string, price: number, qty = 1, extra: Partial<CartLine> = {}): CartLine => ({
  id, itemId: 'i' + id, variantId: 'v' + id, name: 'Drink ' + id, variantLabel: '', basePrice: price, mods: [], notes: [], allergy: '', qty, ...extra,
})
const cartOf = (...lines: CartLine[]): Cart => lines.reduce(addLine, emptyCart())
const promo = (extra: Partial<Promo> = {}): Promo => ({
  id: 'p1', name: 'Promo', kind: 'percent', value: 10, minSpend: 0, days: [], from: '', to: '', startDate: '', endDate: '', appliesToMods: false, code: '', maxUses: 0, active: true, ...extra,
})
// Wednesday 25 Nov 2026
const at = (h: number, m: number) => new Date(2026, 10, 25, h, m)

describe('promo windows (judged when the item was added)', () => {
  const happy = promo({ from: '15:00', to: '17:00', days: [1, 2, 3, 4, 5] })
  it('runs inside its hours and days only', () => {
    expect(inWindow(happy, at(16, 58))).toBe(true)
    expect(inWindow(happy, at(17, 0))).toBe(false)
    expect(inWindow(happy, at(14, 59))).toBe(false)
    expect(inWindow(promo({ days: [0, 6] }), at(10, 0))).toBe(false) // a Wednesday
  })
  it('respects start and end dates (the last day counts)', () => {
    expect(inWindow(promo({ startDate: '2026-11-26' }), at(10, 0))).toBe(false)
    expect(inWindow(promo({ endDate: '2026-11-25' }), at(23, 0))).toBe(true)
    expect(inWindow(promo({ endDate: '2026-11-24' }), at(10, 0))).toBe(false)
  })
  it('a drink added at 4:58 still gets happy hour when paid at 5:03; one added at 5:01 does not', () => {
    const early = line('a', 10000, 1, { addedAt: at(16, 58).toISOString() })
    const late = line('b', 10000, 1, { addedAt: at(17, 1).toISOString() })
    expect(promoReduction(happy, cartOf(early, late), at(17, 3))?.lines).toEqual([{ lineId: 'a', amount: 1000 }])
  })
})

describe('promo maths', () => {
  it('% off takes add-ons only when the promo says so', () => {
    const l = line('a', 10000, 1, { mods: [{ modifierId: 'm', name: 'Shot', qty: 1, unit: 3000, charge: 3000 }] })
    expect(promoReduction(promo(), cartOf(l), at(10, 0))?.total).toBe(1000)
    expect(promoReduction(promo({ appliesToMods: true }), cartOf(l), at(10, 0))?.total).toBe(1300)
  })
  it('₱50 off ₱500+ drops off by itself when an item is removed (re-checked every time)', () => {
    const p = promo({ kind: 'amount', value: 5000, minSpend: 50000 })
    const full = cartOf(line('a', 26000), line('b', 26000)) // ₱520
    expect(promoReduction(p, full, at(10, 0))?.total).toBe(5000)
    expect(promoReduction(p, changeQty(full, 'b', -1), at(10, 0))).toBeNull() // ₱260
    expect(promoReduction(p, cartOf(line('a', 46000)), at(10, 0))).toBeNull() // ₱460: below the minimum
  })
  it('₱ off is shared across lines and always adds up exactly', () => {
    const r = promoReduction(promo({ kind: 'amount', value: 1000 }), cartOf(line('a', 3300), line('b', 3300), line('c', 3300)), at(10, 0))!
    expect(r.lines.reduce((s, l) => s + l.amount, 0)).toBe(1000)
  })
  it('Buy 1 Take 1: the cheaper of each pair is free, even with different items', () => {
    const p = promo({ kind: 'b1t1' })
    expect(promoReduction(p, cartOf(line('latte', 16000), line('mocha', 12000)), at(10, 0))?.total).toBe(12000)
    expect(promoReduction(p, cartOf(line('a', 16000, 3)), at(10, 0))?.total).toBe(16000) // 3 drinks: one free
    expect(promoReduction(p, cartOf(line('a', 16000)), at(10, 0))).toBeNull()
    expect(promoReduction(p, changeQty(cartOf(line('latte', 16000), line('mocha', 12000)), 'mocha', -1), at(10, 0))).toBeNull() // re-checked if one is voided
  })
  it('a code promo only counts when its code was typed; the best promo wins', () => {
    const open = promo({ id: 'a', value: 10 })
    const voucher = promo({ id: 'b', value: 50, code: 'FREE-1' })
    const c = cartOf(line('a', 10000))
    expect(bestPromo([open, voucher], c, at(10, 0))?.promo.id).toBe('a')
    expect(bestPromo([open, voucher], { ...c, promoCode: ' free-1 ' }, at(10, 0))?.promo.id).toBe('b')
    expect(bestPromo([{ ...open, active: false }], c, at(10, 0))).toBeNull()
  })
})

describe('no stacking: the customer gets the lowest price', () => {
  const senior = { kind: 'senior' as const, name: 'Lola', idNumber: 'S1', signed: true, picks: { a: 1 } }
  const latte = () => ({ ...cartOf(line('a', 16800)), discount: senior }) // senior alone: ₱120 (reduction ₱48)
  it('a better promo beats Senior/PWD, and both prices are shown', () => {
    const r = priceCart(latte(), true, { promos: [promo({ value: 30 })], now: at(10, 0) }) // 30% = ₱50.40
    expect(r).toMatchObject({ total: 16800 - 5040, discount: undefined, statutoryLost: true })
    expect(r.promo?.reduction).toBe(5040)
    expect(r.considered.map((c) => c.total)).toEqual([12000, 11760])
  })
  it('a worse promo loses; a tie goes to Senior/PWD', () => {
    expect(priceCart(latte(), true, { promos: [promo({ value: 20 })], now: at(10, 0) }).discount).toBeDefined() // ₱33.60 < ₱48
    const tie = priceCart(latte(), true, { promos: [promo({ kind: 'amount', value: 4800 })], now: at(10, 0) })
    expect(tie.discount).toBeDefined()
    expect(tie.promo).toBeUndefined()
  })
  it('staff discount is ignored when Senior/PWD is on the cart; it competes with promos otherwise', () => {
    const staffCart = { ...cartOf(line('a', 16800)), employee: { id: 'e', name: 'Ana' } }
    expect(priceCart({ ...staffCart, discount: senior }, true, { employeePct: 30, now: at(10, 0) }).employee).toBeUndefined()
    expect(priceCart(staffCart, true, { employeePct: 30, now: at(10, 0) })).toMatchObject({ total: 16800 - 5040, employee: { pct: 30, reduction: 5040 } })
    expect(priceCart(staffCart, true, { employeePct: 30, promos: [promo({ value: 50 })], now: at(10, 0) }).promo).toBeDefined()
  })
})

describe('promos on a sale', () => {
  let t1 = '', cashier = '', staff = ''
  let n = 0
  const k = () => `k${++n}`
  const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]
  const mk = (extra: Partial<Parameters<typeof createPromo>[0]> = {}) =>
    createPromo({ name: 'Promo', kind: 'percent', value: 10, minSpend: 0, days: [], from: '', to: '', startDate: '', endDate: '', appliesToMods: false, code: '', maxUses: 0, ...extra }, cashier)

  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()))
    const b = await createBranch('Main')
    t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
    cashier = (await createUser('Cash', 'cashier', '1111')).id
    staff = (await createUser('Ana', 'barista', '5555')).id
    await openBusinessDay(b.id, cashier)
    await openShift(t1, cashier, { b1000: 2 })
  })

  it('applies the promo, logs where it was used, and a refund gives back only what was paid', async () => {
    const p = await mk({ value: 20 })
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 10000), line('b', 5000)), cash(12000), k())
    expect(order).toMatchObject({ gross: 15000, total: 12000, promo: { promoId: p.id, reduction: 3000 } })
    expect(await db.promoUses.toArray()).toMatchObject([{ promoId: p.id, orderId: order.id, amount: 3000 }])
    expect((await refundableLines(order.id)).map((r) => r.net)).toEqual([8000, 4000])
  })
  it('invoice figures still add up with a promo', async () => {
    await mk({ value: 20 })
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 11200)), cash(9000), k())
    const f = invoiceFigures(order)
    expect(f).toMatchObject({ other: 2240, due: 8960 })
    if (f.vatRegistered) expect(f.vatable + f.vat + f.vatExempt - f.discount).toBe(f.due)
  })
  it('a better promo replaces Senior/PWD: no discount log entry, no ID needed to pay', async () => {
    await mk({ value: 30 })
    const c = { ...cartOf(line('a', 16800)), discount: { kind: 'senior' as const, name: 'Lola', idNumber: 'S1', signed: true, picks: { a: 1 } } }
    const { order } = await payOrder(t1, cashier, c, cash(11760), k())
    expect(order.discount).toBeUndefined()
    expect(order.promo?.reduction).toBe(5040)
    expect(await db.discountLog.count()).toBe(0)
  })
  it('a single-use code works once, then is refused, at entry and at payment', async () => {
    await mk({ name: 'Giveaway', value: 50, code: 'freecoffee-0042', maxUses: 1 })
    const p = await checkCode(' FreeCoffee-0042 ')
    const c = { ...cartOf(line('a', 10000)), promoCode: p.code }
    const { order } = await payOrder(t1, cashier, c, cash(5000), k())
    expect(order.promo).toMatchObject({ code: 'FREECOFFEE-0042', reduction: 5000 })
    await expect(checkCode('FREECOFFEE-0042')).rejects.toThrow(/already used/)
    await expect(payOrder(t1, cashier, c, cash(10000), k())).rejects.toThrow(/already used/)
  })
  it('refuses unknown, switched-off and expired codes', async () => {
    const p = await mk({ code: 'OLD', endDate: '2020-01-01' })
    await expect(checkCode('NOPE')).rejects.toThrow(/No promo/)
    await expect(checkCode('OLD')).rejects.toThrow(/expired/)
    await setPromoActive(p.id, false, cashier)
    await expect(checkCode('OLD')).rejects.toThrow(/switched off/)
  })
  it('staff discount: 30%, one cap per person per day, logged on the order', async () => {
    await setSetting('employeeDiscountDailyCapCentavos', 6000)
    const staffCart = () => ({ ...cartOf(line('a', 16800)), employee: { id: staff, name: 'Ana' } })
    const { order } = await payOrder(t1, cashier, staffCart(), cash(11760), k())
    expect(order.employee).toMatchObject({ employeeId: staff, pct: 30, reduction: 5040 })
    await expect(payOrder(t1, cashier, staffCart(), cash(11760), k())).rejects.toThrow(/staff discount allowed per day/)
    expect(await db.orders.count()).toBe(1)
  })
  it('a large staff discount needs a supervisor PIN like any discount above the cashier limit', async () => {
    await setSetting('employeeDiscountDailyCapCentavos', 100000)
    const big = { ...cartOf(line('a', 16800, 10)), employee: { id: staff, name: 'Ana' } } // 30% of ₱1,680 = ₱504
    await expect(payOrder(t1, cashier, big, cash(200000), k())).rejects.toThrow(/supervisor PIN/)
  })
  it('validates the promo form', async () => {
    await expect(mk({ name: ' ' })).rejects.toThrow(/name/)
    await expect(mk({ value: 0 })).rejects.toThrow(/Percent/)
    await expect(mk({ from: '17:00', to: '15:00' })).rejects.toThrow(/after the start/)
    await mk({ code: 'abc' })
    await expect(mk({ code: 'ABC' })).rejects.toThrow(/already exists/)
  })
})
