import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Bill, type Tab } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { closeBusinessDay, closeShift, dayCloseChecklist, getCloseSummary, openBusinessDay, openShift, submitCloseCount } from './db/shifts'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { voidOrder } from './db/refunds'
import { addRound, buildBill, createTable, mergeTabs, moveTab, setLineSeat, tabTotals, transferTab, walkoutTab } from './db/tabs'
import { loadReport } from './db/reports'
import { createIngredient } from './db/ingredients'
import { saveRecipe } from './db/recipes'
import { receiveStock, stockLevels } from './db/stock'
import { addLine, emptyCart, type Cart, type CartLine } from './lib/cart'
import { allocate, partsByLines, partsCustom, partsEven, partToCartLines } from './lib/split'

let branch = '', t1 = '', t2 = '', ana = '', ben = '', sup = '', tb = { 1: '', 2: '', 3: '', 4: '' } as Record<number, string>
let beans = ''
let n = 0
const k = () => `k${++n}`
const line = (id: string, price: number, extra: Partial<CartLine> = {}): CartLine => ({
  id, itemId: 'i' + id, variantId: 'v1', name: 'Drink ' + id, variantLabel: '', basePrice: price, mods: [], notes: [id], allergy: '', qty: 1, ...extra, // notes keep two drinks from merging into one line
})
const cartOf = (...ls: CartLine[]) => ({ ...ls.reduce(addLine, emptyCart()), orderType: 'dine-in' as const })
const round = (tableId: string, cart: Cart = cartOf(line('a', 10000)), extra = {}) => addRound({ terminalId: t1, userId: ana, tableId, cart, idempotencyKey: k(), ...extra })
const tab = async (id: string) => (await db.tabs.get(id))!
const bean = async () => (await stockLevels(branch)).get(beans) ?? 0

async function payPart(bill: Bill, i: number) {
  const t = await tab(bill.tabId)
  const part = bill.parts[i]
  const cart = { ...emptyCart(), orderType: 'dine-in' as const, table: t.label, lines: partToCartLines(part, t.lines) }
  return payOrder(t1, ana, cart, [{ method: 'cash', tendered: part.amount }], k(), undefined, {}, { tabId: t.id, billId: bill.id, partId: part.id })
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branch = (await createBranch('Main')).id
  t1 = (await createTerminal(branch, 'Counter 1', 'T1')).id
  t2 = (await createTerminal(branch, 'Counter 2', 'T2')).id
  ana = (await createUser('Ana', 'cashier', '1111')).id
  ben = (await createUser('Ben', 'cashier', '5555')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  for (const x of [1, 2, 3, 4]) tb[x] = (await createTable(branch, String(x), 4, sup)).id
  await openBusinessDay(branch, sup)
  await openShift(t1, ana, { b1000: 2 })
  beans = (await createIngredient('Beans', 'g', 'u')).id
  await db.variants.add({ id: 'v1', itemId: 'i', size: '', price: 10000, active: true })
  await saveRecipe('variant', 'v1', [{ ingredientId: beans, qty: 18, op: 'add', when: 'always' }], 'u')
  await receiveStock({ ingredientId: beans, branchId: branch, qty: 1, unit: 'kg', userId: sup })
})

describe('pure splitting', () => {
  it('allocate: pieces differ by at most a centavo and add up exactly', () => {
    expect(allocate(10001, 3)).toEqual([3334, 3334, 3333])
    expect(allocate(90000, 3)).toEqual([30000, 30000, 30000])
    expect(allocate(0, 2)).toEqual([0, 0])
  })
  const d = [{ lineId: 'a', name: 'Latte', variantLabel: '', total: 16800, due: 16800 }, { lineId: 'b', name: 'Cake', variantLabel: '', total: 90000, due: 90000 }]
  let c = 0
  const ids = () => `p${++c}`
  it('by item, a line shared between payers is split equally, and every line must go to someone', () => {
    const parts = partsByLines(d, { a: [0], b: [0, 1, 2] }, ['A', 'B', 'C'], ids)
    expect(parts.map((p) => p.amount)).toEqual([16800 + 30000, 30000, 30000])
    expect(parts[0].lines[0]).toMatchObject({ lineId: 'a', whole: true })
    expect(parts[1].lines[0]).toMatchObject({ share: { n: 3 }, whole: false })
    expect(() => partsByLines(d, { a: [0] }, ['A'], ids)).toThrow(/Give "Cake"/)
    expect(() => partsByLines(d, { a: [0], b: [5] }, ['A'], ids)).toThrow(/does not exist/)
    expect(() => partsByLines(d, { a: [0], b: [0] }, ['A', 'B'], ids)).toThrow(/B has nothing/)
  })
  it('even and custom splits add up to the bill', () => {
    expect(partsEven(d, 3, ids).map((p) => p.amount)).toEqual([35600, 35600, 35600])
    expect(() => partsCustom(d, [50000, 50000], ids)).toThrow(/add up/)
    expect(partsCustom(d, [70000, 36800], ids).map((p) => p.amount)).toEqual([70000, 36800])
  })
  it('a shared line becomes one line at its share, named with the fraction', () => {
    const parts = partsByLines([d[1]], { b: [0, 1, 2] }, ['A', 'B', 'C'], ids)
    const lines = partToCartLines(parts[0], [])
    expect(lines[0]).toMatchObject({ name: 'Cake (1/3)', basePrice: 30000, qty: 1 })
  })
})

describe('tabs', () => {
  it('a round opens the tab, sends the drinks to the bar and takes the stock once', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 10000)))
    expect(t).toMatchObject({ status: 'open', label: '1', rounds: 1, cashierId: ana })
    expect(t.lines.map((l) => [l.addedBy, l.round])).toEqual([[ana, 1], [ana, 1]])
    expect(await db.queueItems.toArray()).toMatchObject([{ tabId: t.id, orderId: t.id, orderNumber: 0, orderLabel: 'Table 1' }, { tabId: t.id }])
    expect(await bean()).toBe(1000 - 36)
    const again = await round(tb[1], cartOf(line('c', 10000)))
    expect(again.id).toBe(t.id)
    expect(again).toMatchObject({ rounds: 2 })
    expect(tabTotals(again).total).toBe(30000)
  })
  it('a repeated tap with the same key adds one round', async () => {
    const key = k()
    await addRound({ terminalId: t1, userId: ana, tableId: tb[1], cart: cartOf(line('a', 10000)), idempotencyKey: key })
    await addRound({ terminalId: t1, userId: ana, tableId: tb[1], cart: cartOf(line('a', 10000)), idempotencyKey: key })
    expect(await db.tabs.count()).toBe(1)
    expect((await db.tabs.toCollection().first())?.lines).toHaveLength(1)
    expect(await bean()).toBe(982)
  })
  it('checks tables and the cart', async () => {
    await expect(addRound({ terminalId: t1, userId: ana, cart: cartOf(line('a', 1)), idempotencyKey: k() })).rejects.toThrow(/Pick a table/)
    await expect(round(tb[1], emptyCart())).rejects.toThrow(/empty/)
    await expect(createTable(branch, '1', 4, sup)).rejects.toThrow(/already exists/)
    await expect(addRound({ terminalId: t1, userId: ben, tableId: tb[1], cart: cartOf(line('a', 1)), idempotencyKey: k() })).rejects.toThrow(/another cashier/)
  })
  it('moves a tab to a free table with the history kept; an occupied table needs a merge', async () => {
    const t = await round(tb[1])
    await round(tb[2])
    await expect(moveTab(t.id, tb[2], ana)).rejects.toThrow(/Merge/)
    await moveTab(t.id, tb[3], ana)
    expect(await tab(t.id)).toMatchObject({ label: '3', tableId: tb[3] })
    expect((await tab(t.id)).events.map((e) => e.kind)).toEqual(['open', 'round', 'move'])
  })
  it('merges two tabs: every line keeps who added it and where it came from, and the bar sees one table', async () => {
    const a = await round(tb[1], cartOf(line('a', 10000)))
    const b = await round(tb[2], cartOf(line('b', 20000)))
    await mergeTabs(a.id, b.id, ana)
    const merged = await tab(a.id)
    expect(merged.lines.map((l) => [l.id, l.fromTable])).toEqual([['a', undefined], ['b', '2']])
    expect(await tab(b.id)).toMatchObject({ status: 'merged', mergedInto: a.id })
    expect((await db.queueItems.toArray()).every((q) => q.orderId === a.id)).toBe(true)
    await expect(mergeTabs(a.id, b.id, ana)).rejects.toThrow(/not open/)
  })
  it('a shift change: the next cashier takes the tab and both names stay on the lines', async () => {
    const t = await round(tb[1])
    await openShift(t2, ben, { b1000: 2 })
    await expect(transferTab({ tabId: t.id, terminalId: t2, userId: ana })).rejects.toThrow(/own shift/)
    await transferTab({ tabId: t.id, terminalId: t2, userId: ben })
    const after = await tab(t.id)
    expect(after).toMatchObject({ cashierId: ben })
    expect(after.lines[0].addedBy).toBe(ana)
    await expect(transferTab({ tabId: t.id, terminalId: t2, userId: ben })).rejects.toThrow(/already yours/)
  })
})

describe('bills and payment', () => {
  it('split by item: each payer gets their own invoice, stock and the bar are not touched again, and the tab closes when all have paid', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 20000), line('c', 5000)))
    const stockBefore = await bean()
    const ticketsBefore = await db.queueItems.count()
    const bill = await buildBill(t.id, { mode: 'item', payers: 2, assign: { a: [0], b: [1], c: [0] } }, ana)
    expect(bill.parts.map((p) => p.amount)).toEqual([15000, 20000])
    const first = await payPart(bill, 0)
    expect(first.order).toMatchObject({ tabId: t.id, total: 15000, table: '1' })
    expect((await tab(t.id)).status).toBe('open')
    const second = await payPart(bill, 1)
    expect(second.order.invoiceNo).not.toBe(first.order.invoiceNo)
    expect(await tab(t.id)).toMatchObject({ status: 'closed' })
    expect((await db.bills.get(bill.id))?.status).toBe('closed')
    expect(await bean()).toBe(stockBefore)
    expect(await db.queueItems.count()).toBe(ticketsBefore)
  })
  it('a cake split three ways: ₱300 each as 1/3, the drink stock taken once', async () => {
    const t = await round(tb[1], cartOf(line('cake', 90000)))
    const bill = await buildBill(t.id, { mode: 'fraction', payers: 3, assign: { cake: [0, 1, 2] } }, ana)
    expect(bill.parts.map((p) => p.amount)).toEqual([30000, 30000, 30000])
    const { order } = await payPart(bill, 0)
    expect(order.lines[0]).toMatchObject({ name: 'Drink cake (1/3)', basePrice: 30000 })
    expect(await bean()).toBe(982)
  })
  it('even split of ₱100.01 between 3 never loses a centavo', async () => {
    const t = await round(tb[1], cartOf(line('a', 10001)))
    const bill = await buildBill(t.id, { mode: 'even', payers: 3 }, ana)
    expect(bill.parts.map((p) => p.amount)).toEqual([3334, 3334, 3333])
    for (let i = 0; i < 3; i++) await payPart(bill, i)
    expect((await tab(t.id)).status).toBe('closed')
    expect(Object.values((await db.orders.toArray()).map((o) => o.total)).reduce((s, x) => s + x, 0)).toBe(10001)
  })
  it('custom amounts must add up; seats split by who sat where, and unseated items are refused', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 20000)))
    await expect(buildBill(t.id, { mode: 'custom', amounts: [10000, 10000] }, ana)).rejects.toThrow(/add up/)
    await expect(buildBill(t.id, { mode: 'seat' }, ana)).rejects.toThrow(/no seat/)
    await setLineSeat(t.id, 'a', 1, ana)
    await setLineSeat(t.id, 'b', 2, ana)
    const bill = await buildBill(t.id, { mode: 'seat' }, ana)
    expect(bill.parts.map((p) => [p.label, p.amount])).toEqual([['Seat 1', 10000], ['Seat 2', 20000]])
  })
  it('one more round replaces the printed bill: the old one is superseded and cannot be paid', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000)))
    const old = await buildBill(t.id, { mode: 'whole' }, ana)
    await round(tb[1], cartOf(line('b', 20000)))
    expect((await db.bills.get(old.id))?.status).toBe('superseded')
    await expect(payPart(old, 0)).rejects.toThrow(/replaced by a newer one/)
    const latest = await buildBill(t.id, { mode: 'whole' }, ana)
    expect(latest).toMatchObject({ version: 2 })
    expect(latest.parts[0].amount).toBe(30000)
  })
  it('after one payer has paid, a new round bills only what is still unpaid', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 20000)))
    const bill = await buildBill(t.id, { mode: 'item', payers: 2, assign: { a: [0], b: [1] } }, ana)
    await payPart(bill, 0)
    await round(tb[1], cartOf(line('c', 5000)))
    const next = await buildBill(t.id, { mode: 'whole' }, ana)
    expect(next.parts[0].amount).toBe(25000) // b and c; a was paid
    expect(tabTotals(await tab(t.id))).toEqual({ total: 35000, due: 25000 })
  })
  it('a part whose amount changed is refused', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000)))
    const bill = await buildBill(t.id, { mode: 'whole' }, ana)
    const cart = { ...emptyCart(), orderType: 'dine-in' as const, lines: [line('a', 9000)] }
    await expect(payOrder(t1, ana, cart, [{ method: 'cash', tendered: 9000 }], k(), undefined, {}, { tabId: t.id, billId: bill.id, partId: bill.parts[0].id })).rejects.toThrow(/no longer matches/)
    expect(await db.orders.count()).toBe(0)
  })
  it('an order paid from a tab is refunded, never voided', async () => {
    const t = await round(tb[1])
    const bill = await buildBill(t.id, { mode: 'whole' }, ana)
    const { order } = await payPart(bill, 0)
    const a = await approve({ action: 'void', requesterId: ana, approverId: sup, pin: '2222', terminalId: t1, amount: 10000, ref: order.id })
    await expect(voidOrder({ orderId: order.id, terminalId: t1, userId: ana, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })).rejects.toThrow(/Use Refund/)
  })
})

describe('walkout', () => {
  it('needs a supervisor PIN and a reason; it is a loss, not a void, and the stock stays used', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 20000)))
    await expect(walkoutTab({ tabId: t.id, terminalId: t1, userId: ana, reason: 'Left', approvalId: undefined })).rejects.toThrow(/supervisor PIN/)
    await expect(walkoutTab({ tabId: t.id, terminalId: t1, userId: ana, reason: ' ' })).rejects.toThrow(/reason/)
    const a = await approve({ action: 'walkout', requesterId: ana, approverId: sup, pin: '2222', terminalId: t1, amount: 30000, ref: t.id })
    const done = await walkoutTab({ tabId: t.id, terminalId: t1, userId: ana, reason: 'Table left without paying', approvalId: a.id })
    expect(done).toMatchObject({ status: 'walkout', walkout: { amount: 30000, approvedBy: sup } })
    expect(await bean()).toBe(1000 - 36)
    const r = await loadReport({ kind: 'day', dayId: (await db.businessDays.toCollection().first())!.id })
    expect(r.walkouts).toEqual({ count: 1, amount: 30000 })
    expect(r.voids.count).toBe(0)
    expect(r.net).toBe(0) // a walkout is never a sale
  })
  it('only the unpaid part is the loss after someone paid their share', async () => {
    const t = await round(tb[1], cartOf(line('a', 10000), line('b', 20000)))
    const bill = await buildBill(t.id, { mode: 'item', payers: 2, assign: { a: [0], b: [1] } }, ana)
    await payPart(bill, 0)
    const a = await approve({ action: 'walkout', requesterId: ana, approverId: sup, pin: '2222', terminalId: t1, amount: 20000, ref: t.id })
    expect((await walkoutTab({ tabId: t.id, terminalId: t1, userId: ana, reason: 'Friend left', approvalId: a.id })).walkout?.amount).toBe(20000)
  })
})

describe('closing with tabs open', () => {
  it('day close is blocked by an open tab until it is billed out or closed as a walkout; shift close flags it', async () => {
    const t = await round(tb[1])
    await submitCloseCount(await shiftOf(ana), ana, { b1000: 2 })
    expect(await getCloseSummary(await shiftOf(ana))).toMatchObject({ openTabs: 1 })
    await closeShift(await shiftOf(ana), ana) // flagged, not blocked
    const day = (await db.businessDays.toCollection().first())!.id
    expect((await dayCloseChecklist(day)).openTabs.map((x: Tab) => x.id)).toEqual([t.id])
    await expect(closeBusinessDay(day, sup)).rejects.toThrow(/1 tab\(s\) are still open/)
  })
})

async function shiftOf(userId: string) {
  return (await db.shifts.filter((s) => s.cashierId === userId && !s.closedAt).first())!.id
}
