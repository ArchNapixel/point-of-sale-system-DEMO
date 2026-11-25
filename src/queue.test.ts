import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { createCategory, createItem, setCategoryStation } from './db/menu'
import { openBusinessDay, openShift } from './db/shifts'
import { payOrder } from './db/orders'
import { setItemStatus, setRush, undoStatus } from './db/queue'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import { byUrgency, orderReady, waitEstimate } from './lib/queue'

let t1 = ''
let drinkItem = ''
let foodItem = ''
let waterItem = ''

const line = (id: string, itemId: string, name: string, extra: Partial<CartLine> = {}): CartLine => ({
  id, itemId, variantId: 'v' + id, name, variantLabel: '16 oz · Iced', basePrice: 10000, mods: [], notes: [], allergy: '', qty: 1, ...extra,
})
const pay = (lines: CartLine[], key: string) =>
  payOrder(t1, 'u1', { ...lines.reduce(addLine, emptyCart()), name: 'Ana' }, [{ method: 'cash', tendered: 100000 }], key)

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  await openBusinessDay(b.id, 'sup')
  await openShift(t1, 'u1', { b1000: 2 })
  const drinks = await createCategory('Drinks')
  const food = await createCategory('Food')
  const bottled = await createCategory('Bottled')
  await setCategoryStation(food.id, 'kitchen')
  await setCategoryStation(bottled.id, 'none')
  drinkItem = (await createItem(drinks.id, 'Latte')).id
  foodItem = (await createItem(food.id, 'Rice meal')).id
  waterItem = (await createItem(bottled.id, 'Water')).id
})

describe('tickets', () => {
  it('a paid order splits by station; no-prep items get no ticket', async () => {
    await pay([line('a', drinkItem, 'Latte'), line('b', foodItem, 'Rice meal'), line('c', waterItem, 'Water')], 'k1')
    const rows = await db.queueItems.toArray()
    expect(rows.map((r) => r.station).sort()).toEqual(['bar', 'kitchen'])
    expect(rows.every((r) => r.status === 'queued' && r.orderNumber === 1)).toBe(true)
  })
  it('an unpaid or failed sale makes no tickets', async () => {
    await expect(payOrder(t1, 'u1', addLine(emptyCart(), line('a', drinkItem, 'Latte')), [{ method: 'cash', tendered: 100 }], 'k1')).rejects.toThrow()
    expect(await db.queueItems.count()).toBe(0)
  })
  it('copies the allergy note onto the ticket', async () => {
    await pay([line('a', drinkItem, 'Latte', { allergy: 'Peanut', qty: 2 })], 'k1')
    expect(await db.queueItems.toArray()).toMatchObject([{ allergy: 'Peanut', qty: 2 }])
  })
})

describe('item status', () => {
  it('each item has its own status; the order is ready only when all items are', async () => {
    await pay([line('a', drinkItem, 'Latte'), line('b', foodItem, 'Rice meal')], 'k1')
    const [drink, food] = [await db.queueItems.where('station').equals('bar').first(), await db.queueItems.where('station').equals('kitchen').first()]
    await setItemStatus(drink!.id, 'ready', 'bar1')
    expect(orderReady(await db.queueItems.toArray())).toBe(false)
    await setItemStatus(food!.id, 'ready', 'k1')
    expect(orderReady(await db.queueItems.toArray())).toBe(true)
    expect(await db.queueEvents.count()).toBe(4) // 2 created + 2 changes: who and when are kept
  })
  it('cannot go backward except by undo; undo works once and keeps history', async () => {
    await pay([line('a', drinkItem, 'Latte')], 'k1')
    const i = (await db.queueItems.toCollection().first())!
    await setItemStatus(i.id, 'ready', 'bar1')
    await expect(setItemStatus(i.id, 'making', 'bar1')).rejects.toThrow(/Already/)
    await undoStatus(i.id, 'bar1')
    expect((await db.queueItems.get(i.id))?.status).toBe('queued')
    await expect(undoStatus(i.id, 'bar1')).rejects.toThrow(/Too late/)
    expect(await db.queueEvents.where('itemId').equals(i.id).count()).toBe(3)
  })
  it('undo expires after a minute', async () => {
    await pay([line('a', drinkItem, 'Latte')], 'k1')
    const i = (await db.queueItems.toCollection().first())!
    await setItemStatus(i.id, 'ready', 'bar1')
    await db.queueItems.update(i.id, { statusAt: new Date(Date.now() - 61_000).toISOString() })
    await expect(undoStatus(i.id, 'bar1')).rejects.toThrow(/Too late/)
  })
})

describe('rush and wait estimate', () => {
  it('a rushed order jumps the queue and shows its reason', async () => {
    await pay([line('a', drinkItem, 'Latte')], 'k1')
    const second = await pay([line('b', drinkItem, 'Mocha')], 'k2')
    await setRush(second.order.id, 'Rider waiting', 'sup')
    const rows = (await db.queueItems.toArray()).sort(byUrgency)
    expect(rows[0]).toMatchObject({ name: 'Mocha', rush: true, rushReason: 'Rider waiting' })
    await expect(setRush(second.order.id, ' ', 'sup')).rejects.toThrow(/reason/)
  })
  it('estimates 6 waiting drinks at 2 min each as about 12 min; ready and picked-up items do not count', () => {
    const items = [
      { station: 'bar' as const, status: 'queued' as const, qty: 4 },
      { station: 'bar' as const, status: 'making' as const, qty: 2 },
      { station: 'bar' as const, status: 'ready' as const, qty: 3 },
      { station: 'kitchen' as const, status: 'queued' as const, qty: 1 },
    ]
    expect(waitEstimate(items, 'bar', 2)).toEqual({ waiting: 6, minutes: 12 })
  })
})
