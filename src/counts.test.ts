import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { createIngredient } from './db/ingredients'
import { saveRecipe } from './db/recipes'
import { payOrder } from './db/orders'
import { receiveDelivery, createSupplier } from './db/purchasing'
import { receiveStock, stockLevels, recordWaste } from './db/stock'
import { applyCount, countReport, countSheet, setCup, submitCount } from './db/counts'
import { marginReport } from './db/costs'
import { setSetting } from './db/settings'
import { addLine, emptyCart } from './lib/cart'
import { cupGap, margin, recipeCost } from './lib/costs'

let branch = '', t1 = '', cashier = '', sup = '', barista = '', supplier = ''
let beans = '', milk = '', cup = ''
let n = 0
const k = () => `c${++n}`
const lvl = async (id: string) => (await stockLevels(branch)).get(id) ?? 0
const latte = (id = 'a', qty = 1) => ({ id, itemId: 'i', variantId: 'v1', name: 'Latte', variantLabel: '16 oz', basePrice: 16800, mods: [], notes: [], allergy: '', qty })
const sell = (qty = 1) => payOrder(t1, cashier, addLine(emptyCart(), latte('a', qty)), [{ method: 'cash', tendered: 16800 * qty }], k())

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branch = (await createBranch('Main')).id
  t1 = (await createTerminal(branch, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  barista = (await createUser('Bar', 'barista', '4444')).id
  supplier = (await createSupplier('Dairy', 0, sup)).id
  await openBusinessDay(branch, sup)
  await openShift(t1, cashier, { b1000: 2 })
  beans = (await createIngredient('Beans', 'g', 'u')).id
  milk = (await createIngredient('Milk', 'ml', 'u')).id
  cup = (await createIngredient('Cup', 'pcs', 'u')).id
  await setCup(cup, true, 'u')
  await db.variants.add({ id: 'v1', itemId: 'i', size: '16 oz', temp: 'iced', price: 16800, active: true })
  await db.items.add({ id: 'i', categoryId: 'c', name: 'Latte', soldOut: false, active: true })
  await saveRecipe('variant', 'v1', [{ ingredientId: beans, qty: 18, op: 'add', when: 'always' }, { ingredientId: milk, qty: 200, op: 'add', when: 'always' }, { ingredientId: cup, qty: 1, op: 'add', when: 'carry' }], 'u')
  const buy = (ingredientId: string, qty: number, unit: string, cost: number) =>
    receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId, qty, unit, cost }], userId: sup, idempotencyKey: k() })
  await buy(beans, 1, 'kg', 120000) // ₱1.20 per g
  await buy(milk, 10, 'L', 90000) // ₱0.09 per ml
  await buy(cup, 100, 'pcs', 50000) // ₱5.00 per cup
})

describe('blind count and variance', () => {
  it('the count sheet shows names and units only, never what is expected', async () => {
    const sheet = await countSheet()
    expect(sheet.map((s) => Object.keys(s).sort())).toEqual(Array(3).fill(['baseUnit', 'id', 'name', 'units']))
  })
  it('works out expected as of the count, then the gap in units and pesos', async () => {
    await sell(2) // beans 1000 → 964
    const c = await submitCount({ branchId: branch, entries: [{ ingredientId: beans, qty: 900, unit: 'g' }, { ingredientId: milk, qty: 9.6, unit: 'L' }], userId: barista, idempotencyKey: k() })
    expect(c.lines).toMatchObject([
      { ingredientId: beans, expected: 964, counted: 900, variance: -64 },
      { ingredientId: milk, expected: 9600, counted: 9600, variance: 0 },
    ])
    const r = await countReport(c.id)
    expect(r.rows[0]).toMatchObject({ variance: -64, pesos: -7680 }) // 64 g × ₱1.20
    expect(r.totalPesos).toBe(-7680)
    expect(await lvl(beans)).toBe(964) // nothing changes until it is applied
  })
  it('applying posts one count movement per difference and sets the level; a count is applied once, by stock authority', async () => {
    await sell()
    const c = await submitCount({ branchId: branch, entries: [{ ingredientId: beans, qty: 950, unit: 'g' }], userId: barista, idempotencyKey: k() })
    await expect(applyCount(c.id, barista)).rejects.toThrow(/supervisor or the owner/)
    await applyCount(c.id, sup)
    expect(await lvl(beans)).toBe(950)
    expect((await db.stockMoves.toArray()).filter((m) => m.kind === 'count')).toMatchObject([{ ingredientId: beans, qty: -32, ref: c.id }])
    await expect(applyCount(c.id, sup)).rejects.toThrow(/already applied/)
  })
  it('a count taken earlier is not distorted by sales rung up after it', async () => {
    const before = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 5))
    await sell(3) // after the count: beans −54
    const c = await submitCount({ branchId: branch, countedAt: before, entries: [{ ingredientId: beans, qty: 990, unit: 'g' }], userId: sup, idempotencyKey: k() })
    expect(c.lines[0]).toMatchObject({ expected: 1000, variance: -10 }) // not −10 + 54
    await applyCount(c.id, sup)
    expect(await lvl(beans)).toBe(1000 - 54 - 10) // the later sales stay deducted
  })
  it('0 is a count; a blank is not counted; checks the form', async () => {
    const c = await submitCount({ branchId: branch, entries: [{ ingredientId: milk, qty: 0, unit: 'ml' }], userId: sup, idempotencyKey: k() })
    expect(c.lines).toMatchObject([{ counted: 0, expected: 10000, variance: -10000 }])
    await expect(submitCount({ branchId: branch, entries: [], userId: sup, idempotencyKey: k() })).rejects.toThrow(/at least one/)
    await expect(submitCount({ branchId: branch, entries: [{ ingredientId: milk, qty: -1, unit: 'ml' }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/negative/)
    await expect(submitCount({ branchId: branch, entries: [{ ingredientId: milk, qty: 1, unit: 'ml' }, { ingredientId: milk, qty: 2, unit: 'ml' }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/twice/)
    await expect(submitCount({ branchId: branch, countedAt: new Date(Date.now() + 3_600_000).toISOString(), entries: [{ ingredientId: milk, qty: 1, unit: 'ml' }], userId: sup, idempotencyKey: k() })).rejects.toThrow(/future/)
    const key = k()
    const a = await submitCount({ branchId: branch, entries: [{ ingredientId: milk, qty: 5, unit: 'L' }], userId: sup, idempotencyKey: key })
    expect((await submitCount({ branchId: branch, entries: [{ ingredientId: milk, qty: 5, unit: 'L' }], userId: sup, idempotencyKey: key })).id).toBe(a.id)
  })
})

describe('cup-count variance', () => {
  it('10 takeout drinks sold but 6 fewer cups on the shelf than expected flags 6 unrung drinks and what they would have sold for', async () => {
    for (let i = 0; i < 10; i++) await sell()
    await recordWaste({ ingredientId: cup, branchId: branch, qty: 6, unit: 'pcs', reason: 'other', note: 'handed out cups', userId: sup }) // cups left the shelf with no sale
    // a count says 84 cups; the ledger expects 90 − … so count what is really there
    const c = await submitCount({ branchId: branch, entries: [{ ingredientId: cup, qty: 84, unit: 'pcs' }], userId: sup, idempotencyKey: k() })
    expect(c.lines[0]).toMatchObject({ expected: 84, variance: 0 }) // waste explained them: no gap
    const c2 = await submitCount({ branchId: branch, entries: [{ ingredientId: cup, qty: 78, unit: 'pcs' }], userId: sup, idempotencyKey: k() })
    const r = await countReport(c2.id)
    expect(r.cups).toMatchObject([{ missing: 6, estimatedLost: 6 * 16800 }])
    expect(r.avgDrinkPrice).toBe(16800)
  })
  it('more cups than expected is not a missing sale', () => {
    expect(cupGap(90, 95, 16800)).toEqual({ missing: 0, estimatedLost: 0 })
    expect(cupGap(90, 84, 16800)).toEqual({ missing: 6, estimatedLost: 100800 })
  })
})

describe('cost per drink and margin', () => {
  it('latte: 18 g beans ₱21.60 + 200 ml milk ₱18.00 = ₱39.60 dine-in; ₱44.60 to go with the cup', async () => {
    const { rows, target } = await marginReport()
    expect(target).toBe(60)
    expect(rows[0]).toMatchObject({ name: 'Latte · 16 oz · Iced', hasRecipe: true, known: true })
    expect(rows[0].dineIn).toMatchObject({ cost: 3960, net: 15000, profit: 11040, pct: 73.6 }) // ₱168 less VAT = ₱150
    expect(rows[0].toGo).toMatchObject({ cost: 4460, pct: 70.3 })
    expect(rows[0].below).toBe(false)
  })
  it('flags a drink under the target margin, and an ingredient with no cost is listed instead of guessed', async () => {
    await setSetting('targetMarginPct', 80)
    expect((await marginReport()).rows[0].below).toBe(true)
    const sugar = (await createIngredient('Sugar', 'g', 'u')).id
    await saveRecipe('variant', 'v1', [{ ingredientId: sugar, qty: 5, op: 'add', when: 'always' }], 'u')
    const r = (await marginReport()).rows[0]
    expect(r.known).toBe(false)
    expect(r.toGo?.unknown).toEqual(['Sugar'])
  })
  it('a supplier raising beans to ₱6,000/kg pushes the latte under target and raises an alert on receiving', async () => {
    await receiveStock({ ingredientId: beans, branchId: branch, qty: 0, unit: 'g', userId: sup }).catch(() => undefined)
    await receiveDelivery({ supplierId: supplier, branchId: branch, lines: [{ ingredientId: beans, qty: 100, unit: 'kg', cost: 60_000_000 }], userId: sup, idempotencyKey: k() })
    expect((await marginReport()).rows[0].below).toBe(true)
    expect((await db.auditLog.where('action').equals('margin.alert').first())?.detail?.drinks).toEqual(['Latte · 16 oz · Iced'])
  })
  it('pure maths: margin is worked out on the price without VAT', () => {
    expect(margin(11200, 4000, true)).toEqual({ net: 10000, profit: 6000, pct: 60 })
    expect(margin(10000, 4000, false)).toEqual({ net: 10000, profit: 6000, pct: 60 })
    expect(recipeCost(new Map([['a', 100], ['b', 5]]), new Map([['a', 1500], ['b', undefined]]))).toEqual({ cost: 150, unknown: ['b'] })
  })
})
