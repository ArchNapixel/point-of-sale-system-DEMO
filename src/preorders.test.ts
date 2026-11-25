import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { closeBusinessDay, closeShift, dayCloseChecklist, expectedCash, openBusinessDay, openShift, submitCloseCount } from './db/shifts'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { cancelPreOrder, createPreOrder, heldDeposit, startPrep } from './db/preorders'
import { channelPriceMap, createChannel, dailyCheck, netOfCommission, receivables, setChannelPrice, setCommission, settlePayout } from './db/channels'
import { loadReport } from './db/reports'
import { createIngredient } from './db/ingredients'
import { saveRecipe } from './db/recipes'
import { receiveStock, stockLevels } from './db/stock'
import { addLine, emptyCart, type Cart, type CartLine } from './lib/cart'
import { drinkCount, dueSoon, startBy, timeline } from './lib/preorders'
import { applyLines } from './lib/payments'

let branch = '', t1 = '', cashier = '', sup = '', day = '', shift = ''
let beans = ''
let n = 0
const k = () => `k${++n}`
const line = (id: string, price: number, qty = 1): CartLine => ({ id, itemId: 'i', variantId: 'v1', name: 'Latte ' + id, variantLabel: '', basePrice: price, mods: [], notes: [id], allergy: '', qty })
const cartOf = (...ls: CartLine[]): Cart => ls.reduce(addLine, emptyCart())
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const bean = async () => (await stockLevels(branch)).get(beans) ?? 0

const book = (extra: Partial<Parameters<typeof createPreOrder>[0]> = {}) => {
  const lines = [line('a', 10000, 3)] // 30 coffees' worth, scaled down
  return createPreOrder({ terminalId: t1, userId: cashier, customerName: 'Office', kind: 'pickup', pickupAt: inHours(2), lines, depositPolicy: 'refund', idempotencyKey: k(), ...extra })
}
const cartFor = async (preId: string, extra: Partial<Cart> = {}): Promise<Cart> => {
  const p = (await db.preOrders.get(preId))!
  return { ...emptyCart(), orderType: 'pickup', name: p.customerName, lines: p.lines, ...(p.deliveryFee && { deliveryFee: p.deliveryFee }), ...extra }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branch = (await createBranch('Main')).id
  t1 = (await createTerminal(branch, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  day = (await openBusinessDay(branch, sup)).id
  shift = (await openShift(t1, cashier, { b1000: 2 })).id
  beans = (await createIngredient('Beans', 'g', 'u')).id
  await db.variants.add({ id: 'v1', itemId: 'i', size: '', price: 10000, active: true })
  await saveRecipe('variant', 'v1', [{ ingredientId: beans, qty: 18, op: 'add', when: 'always' }], 'u')
  await receiveStock({ ingredientId: beans, branchId: branch, qty: 1, unit: 'kg', userId: sup })
})

describe('timeline and reminders', () => {
  const mk = (id: string, mins: number, drinks: number, status = 'booked') => ({ id, status, pickupAt: new Date(Date.now() + mins * 60_000).toISOString(), lines: [{ qty: drinks }] })
  it('start-by is the pickup time less the work needed; bulk orders are marked', () => {
    const at = '2026-11-25T09:00:00.000Z'
    expect(startBy(at, 30, 2).toISOString()).toBe('2026-11-25T08:00:00.000Z')
    const t = timeline([mk('big', 60, 30), mk('small', 90, 2), mk('done', 30, 5, 'fulfilled')], 10, 2)
    expect(t.map((x) => [x.order.id, x.bulk, x.drinks])).toEqual([['big', true, 30], ['small', false, 2]])
    expect(drinkCount([{ qty: 3 }, { qty: 4 }])).toBe(7)
  })
  it('the bar is reminded the lead time before pickup, or earlier when the order is big', () => {
    const now = new Date()
    expect(dueSoon([mk('a', 20, 2)], now, 30, 2).map((o) => o.id)).toEqual(['a']) // due in 20 min: inside the 30 min lead
    expect(dueSoon([mk('b', 120, 2)], now, 30, 2)).toEqual([])
    expect(dueSoon([mk('small', 50, 2)], now, 30, 2)).toEqual([]) // 50 min away: the 30 min reminder has not come
    expect(dueSoon([mk('big', 50, 30)], now, 30, 2).map((o) => o.id)).toEqual(['big']) // 30 drinks need 60 min: it should have started already
    expect(dueSoon([mk('d', 20, 2, 'preparing')], now, 30, 2)).toEqual([]) // already started
  })
})

describe('deposits', () => {
  it('a cash deposit goes in the drawer but is not a sale: expected cash rises, net sales stay 0, and it is shown as still held', async () => {
    const before = await expectedCash(shift)
    const { deposit } = await book({ deposit: { amount: 15000, method: 'cash' } })
    expect(deposit).toMatchObject({ amount: 15000, status: 'held', shiftId: shift })
    expect(await expectedCash(shift)).toBe(before + 15000)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ net: 0, gross: 0, deposits: { taken: 15000, held: 15000, refunded: 0, forfeited: 0 } })
  })
  it('checks the booking: name, future time, deposit amount and e-wallet reference', async () => {
    await expect(book({ customerName: ' ' })).rejects.toThrow(/name/)
    await expect(book({ pickupAt: inHours(-3) })).rejects.toThrow(/future/)
    await expect(book({ deposit: { amount: 0, method: 'cash' } })).rejects.toThrow(/deposit amount/)
    await expect(book({ deposit: { amount: 99999999, method: 'cash' } })).rejects.toThrow(/more than the order/)
    await expect(book({ deposit: { amount: 1000, method: 'transfer' } })).rejects.toThrow(/reference/)
    await book({ deposit: { amount: 1000, method: 'transfer', reference: 'bpi-1' } })
    await expect(book({ deposit: { amount: 1000, method: 'gcash', reference: 'BPI-1' } })).rejects.toThrow(/already used/)
  })
  it('a deposit needs an open shift on a terminal', async () => {
    await db.shifts.update(shift, { closedAt: 'x' })
    await expect(book({ deposit: { amount: 1000, method: 'cash' } })).rejects.toThrow(/open shift/)
    expect((await book()).preOrder.status).toBe('booked') // booking without money does not need a shift
  })
  it('the same booking key saves once', async () => {
    const key = k()
    const a = await book({ idempotencyKey: key, deposit: { amount: 1000, method: 'cash' } })
    const b = await book({ idempotencyKey: key, deposit: { amount: 1000, method: 'cash' } })
    expect(b.preOrder.id).toBe(a.preOrder.id)
    expect(await db.deposits.count()).toBe(1)
  })
})

describe('making and collecting a pre-order', () => {
  it('start prep puts rushed tickets on the bar and takes the stock; collecting applies the deposit, takes the balance and does not make it twice', async () => {
    const { preOrder, deposit } = await book({ deposit: { amount: 15000, method: 'cash' } })
    await startPrep(preOrder.id, sup)
    expect(await db.queueItems.toArray()).toMatchObject([{ orderId: preOrder.id, preOrderId: preOrder.id, orderLabel: 'Office', rush: true, qty: 3 }])
    expect(await bean()).toBe(1000 - 54)
    await expect(startPrep(preOrder.id, sup)).rejects.toThrow(/not waiting/)

    const cart = await cartFor(preOrder.id)
    await expect(payOrder(t1, cashier, cart, [{ method: 'cash', tendered: 30000 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })).rejects.toThrow(/Apply the .*150.00 deposit/)
    const { order, payments } = await payOrder(t1, cashier, cart, [{ method: 'deposit', amount: 15000, reference: deposit!.id }, { method: 'cash', tendered: 15000 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })
    expect(order).toMatchObject({ total: 30000, preOrderId: preOrder.id })
    expect(payments.map((p) => [p.method, p.amount])).toEqual([['deposit', 15000], ['cash', 15000]])
    expect(await db.preOrders.get(preOrder.id)).toMatchObject({ status: 'fulfilled', orderId: order.id })
    expect((await db.deposits.get(deposit!.id))?.status).toBe('applied')
    expect(await bean()).toBe(1000 - 54) // not deducted a second time
    expect(await db.queueItems.count()).toBe(1)
    // the cash drawer: ₱150 came in as a deposit and ₱150 at pickup. The deposit line itself is not cash.
    expect(await expectedCash(shift)).toBe(200000 + 15000 + 15000)
  })
  it('collected without the bar starting it first: it is made at payment as usual', async () => {
    const { preOrder } = await book()
    await payOrder(t1, cashier, await cartFor(preOrder.id), [{ method: 'cash', tendered: 30000 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })
    expect(await bean()).toBe(1000 - 54)
    expect(await db.queueItems.count()).toBe(1)
  })
  it('the bill must match the pre-order, and there is no deposit line without a deposit', async () => {
    const { preOrder } = await book()
    const changed = await cartFor(preOrder.id)
    await expect(payOrder(t1, cashier, { ...changed, lines: [line('a', 9000, 3)] }, [{ method: 'cash', tendered: 99999 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })).rejects.toThrow(/no longer matches/)
    await expect(payOrder(t1, cashier, changed, [{ method: 'deposit', amount: 100, reference: 'x' }, { method: 'cash', tendered: 30000 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })).rejects.toThrow(/no deposit/)
  })
  it('an order made ahead is refunded, never voided', async () => {
    const { preOrder } = await book()
    await startPrep(preOrder.id, sup)
    const { order } = await payOrder(t1, cashier, await cartFor(preOrder.id), [{ method: 'cash', tendered: 30000 }], k(), undefined, {}, undefined, { preOrderId: preOrder.id })
    const a = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 30000, ref: order.id })
    const { voidOrder } = await import('./db/refunds')
    await expect(voidOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })).rejects.toThrow(/Use Refund/)
  })
})

describe('cancelling a pre-order', () => {
  const pin = (id: string, amount: number) => approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount, ref: id })
  it('refund policy: needs a PIN and a reason, the deposit goes back out of the drawer, nothing was made', async () => {
    const { preOrder, deposit } = await book({ deposit: { amount: 15000, method: 'cash' } })
    const args = { preOrderId: preOrder.id, userId: cashier, terminalId: t1, reasonCode: 'customer-cancelled' }
    await expect(cancelPreOrder({ ...args, reasonCode: '' })).rejects.toThrow(/Pick a reason/)
    await expect(cancelPreOrder(args)).rejects.toThrow(/supervisor PIN/)
    const out = await cancelPreOrder({ ...args, approvalId: (await pin(preOrder.id, 15000)).id })
    expect(out).toEqual({ outcome: 'refunded', wasMade: false, amount: 15000 })
    expect((await db.deposits.get(deposit!.id))?.status).toBe('refunded')
    expect(await expectedCash(shift)).toBe(200000) // in and out again
    expect((await db.preOrders.get(preOrder.id))?.status).toBe('cancelled')
    expect(await heldDeposit(preOrder.id)).toBeUndefined()
  })
  it('keep policy: the deposit is kept (forfeited), and stays in the drawer', async () => {
    const { preOrder, deposit } = await book({ depositPolicy: 'keep', deposit: { amount: 15000, method: 'cash' } })
    await cancelPreOrder({ preOrderId: preOrder.id, userId: cashier, terminalId: t1, reasonCode: 'customer-cancelled', approvalId: (await pin(preOrder.id, 15000)).id })
    expect((await db.deposits.get(deposit!.id))?.status).toBe('forfeited')
    expect(await expectedCash(shift)).toBe(215000)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.deposits).toMatchObject({ taken: 15000, forfeited: 15000, held: 0 })
  })
  it('if the bar had started, the drinks are waste: the tickets are voided and marked wasted, the stock stays used', async () => {
    const { preOrder } = await book()
    await startPrep(preOrder.id, sup)
    const out = await cancelPreOrder({ preOrderId: preOrder.id, userId: cashier, terminalId: t1, reasonCode: 'customer-cancelled' }) // no deposit: no PIN
    expect(out).toMatchObject({ wasMade: true, outcome: 'none' })
    expect(await db.queueItems.toArray()).toMatchObject([{ status: 'void', wasted: true }])
    expect(await bean()).toBe(1000 - 54)
    await expect(cancelPreOrder({ preOrderId: preOrder.id, userId: cashier, terminalId: t1, reasonCode: 'customer-cancelled' })).rejects.toThrow(/cannot be cancelled/)
  })
})

describe('delivery fee', () => {
  it('is paid with the order, shown on its own, and never in sales or discounted', async () => {
    const cart = { ...cartOf(line('a', 10000)), deliveryFee: 9000 }
    await expect(payOrder(t1, cashier, cart, [{ method: 'cash', tendered: 10000 }], k())).rejects.toThrow(/still to pay/)
    const { order, change } = await payOrder(t1, cashier, cart, [{ method: 'cash', tendered: 20000 }], k())
    expect(order).toMatchObject({ gross: 10000, total: 10000, deliveryFee: 9000 })
    expect(change).toBe(1000)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ gross: 10000, net: 10000, deliveryFees: 9000 })
    expect(r.cash.sales).toBe(19000) // all of it came into the drawer
  })
})

describe('delivery channels', () => {
  let grab = ''
  beforeEach(async () => {
    grab = (await createChannel('GrabFood', 20, sup)).id
  })
  const channelCart = (price = 12000): Cart => ({ ...cartOf(line('a', price)), channelId: grab })

  it('the commission is a setting per platform and checked', async () => {
    await expect(createChannel('X', 150, sup)).rejects.toThrow(/0 to 100/)
    await expect(createChannel('grabfood', 10, sup)).rejects.toThrow(/already exists/)
  })
  it('channel prices override the counter price for a size, and can be cleared', async () => {
    await setChannelPrice(grab, 'v1', 12000, sup)
    expect((await channelPriceMap(grab)).get('v1')).toBe(12000)
    await setChannelPrice(grab, 'v1', null, sup)
    expect((await channelPriceMap(grab)).size).toBe(0)
    await expect(setChannelPrice(grab, 'v1', 0, sup)).rejects.toThrow(/price/)
  })
  it('an order keyed under the app is paid by the app (a receivable), keeps its commission %, and is a sale', async () => {
    const { order, payments } = await payOrder(t1, cashier, channelCart(), [{ method: 'platform', amount: 12000 }], k())
    expect(order).toMatchObject({ channelId: grab, channelName: 'GrabFood', commissionPct: 20 })
    expect(payments[0]).toMatchObject({ method: 'platform', status: 'receivable' })
    await setCommission(grab, 25, sup) // new orders only
    expect((await db.orders.get(order.id))?.commissionPct).toBe(20)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.net).toBe(12000)
    expect(r.cash.sales).toBe(0) // no cash came in
    expect(r.channels).toEqual([{ channelId: grab, name: 'GrabFood', orders: 1, sales: 12000, commission: 2400, owed: 9600 }])
  })
  it('the app pays, never the till: cash on a channel order, or platform payment on a counter order, is refused', async () => {
    await expect(payOrder(t1, cashier, channelCart(), [{ method: 'cash', tendered: 12000 }], k())).rejects.toThrow(/paid by the app/)
    await expect(payOrder(t1, cashier, cartOf(line('a', 10000)), [{ method: 'platform', amount: 10000 }], k())).rejects.toThrow(/only for delivery app/)
    await db.channels.update(grab, { active: false })
    await expect(payOrder(t1, cashier, channelCart(), [{ method: 'platform', amount: 12000 }], k())).rejects.toThrow(/switched off/)
  })
  it('a receivable does not block day close; the weekly payout settles the orders and shows the gap', async () => {
    const a = (await payOrder(t1, cashier, channelCart(12000), [{ method: 'platform', amount: 12000 }], k())).order
    const b = (await payOrder(t1, cashier, channelCart(10000), [{ method: 'platform', amount: 10000 }], k())).order
    expect((await receivables(grab)).map((o) => o.id)).toEqual([a.id, b.id])
    expect(netOfCommission(12000, 20)).toBe(9600)
    await submitCloseCount(shift, cashier, { b1000: 2 })
    await closeShift(shift, cashier)
    expect((await dayCloseChecklist(day)).ok).toBe(true)
    await closeBusinessDay(day, sup)
    await expect(settlePayout({ channelId: grab, orderIds: [], received: 1, userId: sup })).rejects.toThrow(/Pick the orders/)
    const p = await settlePayout({ channelId: grab, orderIds: [a.id, b.id], received: 17000, reference: 'GRAB-W47', userId: sup })
    expect(p).toMatchObject({ gross: 22000, expected: 17600, received: 17000 }) // ₱6 less than expected: look into it
    expect(await receivables(grab)).toEqual([])
    expect((await db.payments.where('orderId').equals(a.id).first())?.status).toBe('verified')
    await expect(settlePayout({ channelId: grab, orderIds: [a.id], received: 1, userId: sup })).rejects.toThrow(/not waiting/)
  })
  it('the daily check compares the app order count with the POS and logs a gap', async () => {
    await payOrder(t1, cashier, channelCart(), [{ method: 'platform', amount: 12000 }], k())
    const date = (await db.businessDays.get(day))!.date
    expect(await dailyCheck({ channelId: grab, date, platformCount: 1, userId: sup })).toEqual({ posCount: 1, missing: 0 })
    expect(await dailyCheck({ channelId: grab, date, platformCount: 3, userId: sup })).toEqual({ posCount: 1, missing: 2 })
    expect(await db.auditLog.where('action').equals('channel.countGap').count()).toBe(1)
  })
  it('a cancelled delivery order is refunded with the app-cancellation reason', async () => {
    const { order } = await payOrder(t1, cashier, channelCart(), [{ method: 'platform', amount: 12000 }], k())
    await db.queueItems.toCollection().modify({ status: 'served' })
    const a = await approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 12000, ref: order.id })
    const { refundOrder } = await import('./db/refunds')
    const r = await refundOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'channel-cancel', reasonNote: 'Rider cancelled; Grab may compensate', approvalId: a.id, idempotencyKey: k(), picks: { a: 1 }, method: 'platform' })
    expect(r).toMatchObject({ method: 'platform', cashAmount: 0, madeBefore: true, reasonCode: 'channel-cancel' })
  })
})

describe('payment methods added in this part', () => {
  it('a bank transfer needs a reference and waits for verification like an e-wallet', () => {
    expect(() => applyLines(10000, [{ method: 'transfer', amount: 10000 }])).toThrow(/reference/)
    expect(applyLines(10000, [{ method: 'transfer', amount: 10000, reference: 'BPI-9' }]).applied[0].status).toBe('pending')
  })
  it('a deposit line needs its deposit; a delivery-app line is a receivable', () => {
    expect(() => applyLines(10000, [{ method: 'deposit', amount: 5000 }])).toThrow(/deposit it comes from/)
    expect(applyLines(10000, [{ method: 'platform', amount: 10000 }]).applied[0].status).toBe('receivable')
  })
})
