import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { addUnit, createIngredient } from './db/ingredients'
import { saveRecipe } from './db/recipes'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { voidOrder } from './db/refunds'
import { remakeItem } from './db/queue'
import { setModifierSoldOut } from './db/modifiers'
import { adjustToCount, negativeStock, produce, receiveStock, recordWaste, stockLevels, transferStock } from './db/stock'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import type { RecipeLine } from './lib/recipes'

let b1 = '', b2 = '', t1 = '', cashier = '', barista = '', sup = ''
let beans = '', milk = '', oat = '', cup = ''
let n = 0
const k = () => `k${++n}`
const L = (ingredientId: string, qty: number, extra: Partial<RecipeLine> = {}): RecipeLine => ({ ingredientId, qty, op: 'add', when: 'always', ...extra })
const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]
const latte = (extra: Partial<CartLine> = {}): CartLine => ({ id: 'a', itemId: 'i', variantId: 'v1', name: 'Latte', variantLabel: '16 oz', basePrice: 16800, mods: [], notes: [], allergy: '', qty: 1, ...extra })
const oatMod = { modifierId: 'oat', name: 'Oat milk', qty: 1, unit: 0, charge: 0 }
const level = async (id: string, branch = b1) => (await stockLevels(branch)).get(id) ?? 0

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  b1 = (await createBranch('Main')).id
  b2 = (await createBranch('Second')).id
  t1 = (await createTerminal(b1, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  barista = (await createUser('Bar', 'barista', '4444')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  await openBusinessDay(b1, sup)
  await openShift(t1, cashier, { b1000: 2 })
  beans = (await createIngredient('Beans', 'g', 'u')).id
  milk = (await createIngredient('Milk', 'ml', 'u')).id
  oat = (await createIngredient('Oat milk', 'ml', 'u')).id
  cup = (await createIngredient('Cup', 'pcs', 'u')).id
  await db.variants.add({ id: 'v1', itemId: 'i', size: '16 oz', temp: 'iced', price: 16800, active: true })
  await db.modifiers.add({ id: 'oat', groupId: 'g', name: 'Oat milk', price: 0, sizePrices: {}, freeQty: 0, maxQty: 1, soldOut: false, sort: 0, active: true })
  await saveRecipe('variant', 'v1', [L(beans, 18), L(milk, 200), L(cup, 1, { when: 'carry' })], 'u')
  await saveRecipe('modifier', 'oat', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: oat, when: 'always' }], 'u')
  await receiveStock({ ingredientId: beans, branchId: b1, qty: 1, unit: 'kg', userId: sup })
  await receiveStock({ ingredientId: milk, branchId: b1, qty: 2, unit: 'L', userId: sup })
  await receiveStock({ ingredientId: cup, branchId: b1, qty: 50, unit: 'pcs', userId: sup })
  await receiveStock({ ingredientId: oat, branchId: b1, qty: 300, unit: 'ml', userId: sup })
})

describe('the ledger', () => {
  it('stock is the sum of movements; receiving adds in any unit', async () => {
    expect(await level(beans)).toBe(1000)
    expect(await level(milk)).toBe(2000)
    expect(await level(milk, b2)).toBe(0) // each branch has its own
  })
  it('a takeout sale deducts the recipe, a dine-in sale skips the cup, both in the order’s save', async () => {
    await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k()) // emptyCart is takeout
    expect([await level(beans), await level(milk), await level(cup)]).toEqual([982, 1800, 49])
    await payOrder(t1, cashier, { ...addLine(emptyCart(), latte()), orderType: 'dine-in' }, cash(16800), k())
    expect([await level(beans), await level(milk), await level(cup)]).toEqual([964, 1600, 49])
    const move = (await db.stockMoves.where('kind').equals('sale').first().catch(() => undefined)) ?? (await db.stockMoves.toArray()).find((m) => m.kind === 'sale')
    expect(move?.recipeVersions?.length).toBeGreaterThan(0) // old sales know which recipe they used
  })
  it('a comped drink still deducts stock', async () => {
    await payOrder(t1, cashier, addLine(emptyCart(), latte({ comp: { code: 'wrong-order', note: '' } })), [], k()).catch(() => undefined)
    // over the cashier's comp limit: nothing sold, nothing deducted
    expect(await level(beans)).toBe(1000)
    await payOrder(t1, cashier, addLine(emptyCart(), latte({ basePrice: 4000, comp: { code: 'wrong-order', note: '' } })), [], k())
    expect(await level(beans)).toBe(982)
  })
  it('never blocks a sale: stock goes negative, a supervisor is alerted once', async () => {
    await adjustToCount({ ingredientId: beans, branchId: b1, counted: 20, unit: 'g', userId: sup })
    await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k()) // 20 → 2
    await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k()) // 2 → -16
    await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k()) // -16 → -34
    expect(await level(beans)).toBe(-34)
    expect((await negativeStock()).map((x) => [x.name, x.qty])).toEqual([['Beans', -34]])
    expect(await db.auditLog.where('action').equals('stock.negative').count()).toBe(1)
    expect(await db.orders.count()).toBe(3)
  })
  it('voiding an order puts its ingredients back', async () => {
    const { order } = await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k())
    expect(await level(milk)).toBe(1800)
    const a = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 16800, ref: order.id })
    await voidOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })
    expect([await level(beans), await level(milk), await level(cup)]).toEqual([1000, 2000, 50])
  })
  it('a remake uses the ingredients a second time', async () => {
    await payOrder(t1, cashier, addLine(emptyCart(), latte()), cash(16800), k())
    await remakeItem((await db.queueItems.toCollection().first())!.id, barista, 'quality-complaint')
    expect(await level(beans)).toBe(1000 - 18 - 18)
    expect((await db.stockMoves.toArray()).filter((m) => m.kind === 'waste' && m.reason === 'remake')).toHaveLength(3)
  })
})

describe('waste', () => {
  it('needs a reason; "Other" needs a note; amounts convert from any unit', async () => {
    const w = { ingredientId: milk, branchId: b1, qty: 1, unit: 'L', userId: barista }
    await expect(recordWaste({ ...w, reason: '' })).rejects.toThrow(/Pick a reason/)
    await expect(recordWaste({ ...w, reason: 'other' })).rejects.toThrow(/note/)
    await expect(recordWaste({ ...w, qty: 0, reason: 'spoiled' })).rejects.toThrow(/more than 0/)
    await recordWaste({ ...w, reason: 'spoiled' })
    expect(await level(milk)).toBe(1000)
    expect(await db.auditLog.where('action').equals('stock.waste').count()).toBe(1)
  })
  it('grinder calibration and staff meals have their own reasons', async () => {
    await recordWaste({ ingredientId: beans, branchId: b1, qty: 80, unit: 'g', reason: 'calibration', userId: barista })
    await recordWaste({ ingredientId: beans, branchId: b1, qty: 18, unit: 'g', reason: 'staff-meal', userId: barista })
    expect(await level(beans)).toBe(902)
    expect((await db.stockMoves.toArray()).filter((m) => m.kind === 'waste').map((m) => m.reason).sort()).toEqual(['calibration', 'staff-meal'])
  })
})

describe('transfer, production and count', () => {
  it('a transfer is one movement out and one in, linked', async () => {
    await transferStock({ ingredientId: milk, fromBranchId: b1, toBranchId: b2, qty: 1, unit: 'L', userId: sup })
    expect([await level(milk, b1), await level(milk, b2)]).toEqual([1000, 1000])
    const [out, inn] = (await db.stockMoves.toArray()).filter((m) => m.kind.startsWith('transfer'))
    expect(out.pairId).toBe(inn.pairId)
    await expect(transferStock({ ingredientId: milk, fromBranchId: b1, toBranchId: b1, qty: 1, unit: 'L', userId: sup })).rejects.toThrow(/two different/)
  })
  it('production turns raw ingredients into a prep item: 1 kg beans + 8 L water make 6.5 L cold brew', async () => {
    const water = (await createIngredient('Water', 'ml', 'u')).id
    const brew = (await createIngredient('Cold brew', 'ml', 'u')).id
    await receiveStock({ ingredientId: water, branchId: b1, qty: 10, unit: 'L', userId: sup })
    await produce({ branchId: b1, inputs: [{ ingredientId: beans, qty: 1, unit: 'kg' }, { ingredientId: water, qty: 8, unit: 'L' }], outputIngredientId: brew, outQty: 6.5, outUnit: 'L', userId: sup })
    expect([await level(beans), await level(water), await level(brew)]).toEqual([0, 2000, 6500])
  })
  it('a count writes the difference; the level is never overwritten', async () => {
    const r = await adjustToCount({ ingredientId: milk, branchId: b1, counted: 1.5, unit: 'L', note: 'Sunday count', userId: sup })
    expect(r.diff).toBe(-500)
    expect(await level(milk)).toBe(1500)
    expect(await db.stockMoves.where('ingredientId').equals(milk).count()).toBe(2) // the receive and the correction, both kept
  })
})

describe('add-ons switch off when an ingredient runs out', () => {
  it('oat milk runs out → the add-on is sold out; stock comes back → it is available again', async () => {
    const offs = () => db.auditLog.where('action').equals('modifier.autoSoldOut').count()
    const before = await offs() // set-up receiving beans first left oat at 0 for a moment, which is also right
    await payOrder(t1, cashier, addLine(emptyCart(), latte({ mods: [oatMod] })), cash(16800), k()) // 300 → 100 ml oat
    expect((await db.modifiers.get('oat'))?.soldOut).toBe(false)
    await payOrder(t1, cashier, addLine(emptyCart(), latte({ id: 'b', mods: [oatMod] })), cash(16800), k()) // 100 → -100
    expect(await db.modifiers.get('oat')).toMatchObject({ soldOut: true, autoSoldOut: true })
    expect(await offs()).toBe(before + 1)
    await receiveStock({ ingredientId: oat, branchId: b1, qty: 5, unit: 'L', userId: sup })
    expect(await db.modifiers.get('oat')).toMatchObject({ soldOut: false, autoSoldOut: false })
  })
  it('a manual "sold out" is not switched back on by stock', async () => {
    await setModifierSoldOut('oat', true)
    await receiveStock({ ingredientId: oat, branchId: b1, qty: 1, unit: 'ml', userId: sup })
    expect((await db.modifiers.get('oat'))?.soldOut).toBe(true)
  })
  it('works from waste too', async () => {
    await recordWaste({ ingredientId: oat, branchId: b1, qty: 300, unit: 'ml', reason: 'spoiled', userId: barista })
    expect((await db.modifiers.get('oat'))?.soldOut).toBe(true)
  })
  it('units still convert after stock exists (a case of milk)', async () => {
    await addUnit(milk, 'case', 12000, 'u')
    await receiveStock({ ingredientId: milk, branchId: b1, qty: 1, unit: 'case', userId: sup })
    expect(await level(milk)).toBe(14000)
  })
})
