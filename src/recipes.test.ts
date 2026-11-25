import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { addUnit, createIngredient, setIngredientActive } from './db/ingredients'
import { currentRecipe, deductionsForLine, recipeHistory, saveRecipe } from './db/recipes'
import { resolveRecipe, type RecipeLine } from './lib/recipes'

let beans = '', milk = '', oat = '', cup = '', lid = '', syrup = ''
const L = (ingredientId: string, qty: number, extra: Partial<RecipeLine> = {}): RecipeLine => ({ ingredientId, qty, op: 'add', when: 'always', ...extra })

// 16 oz iced latte: 18 g beans, 200 ml milk, 1 cup, 1 lid (cup and lid only to go)
const latte = () => [L(beans, 18), L(milk, 200), L(cup, 1, { when: 'carry' }), L(lid, 1, { when: 'carry' })]
const m = (_name: string, lines: RecipeLine[], qty = 1) => ({ lines, qty })
const obj = (u: Map<string, number>) => Object.fromEntries(u)

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  beans = (await createIngredient('Beans', 'g', 'u')).id
  milk = (await createIngredient('Milk', 'ml', 'u')).id
  oat = (await createIngredient('Oat milk', 'ml', 'u')).id
  cup = (await createIngredient('Cup', 'pcs', 'u')).id
  lid = (await createIngredient('Lid', 'pcs', 'u')).id
  syrup = (await createIngredient('Vanilla syrup', 'ml', 'u')).id
  await addUnit(syrup, 'pump', 10, 'u')
})

describe('resolving a drink', () => {
  it('takeout uses the cup and lid; dine-in does not', () => {
    expect(obj(resolveRecipe(latte(), [], true))).toEqual({ [beans]: 18, [milk]: 200, [cup]: 1, [lid]: 1 })
    expect(obj(resolveRecipe(latte(), [], false))).toEqual({ [beans]: 18, [milk]: 200 })
  })
  it('an extra shot adds 9 g of beans, and 2 pumps of syrup add 20 ml', () => {
    const shot = m('shot', [L(beans, 9)])
    const pumps = m('vanilla', [L(syrup, 10)], 2)
    expect(obj(resolveRecipe(latte(), [shot, pumps], false))).toEqual({ [beans]: 27, [milk]: 200, [syrup]: 20 })
  })
  it('oat milk replaces the 200 ml of milk with 200 ml oat', () => {
    const swap = m('oat', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: oat, when: 'always' }])
    expect(obj(resolveRecipe(latte(), [swap], false))).toEqual({ [beans]: 18, [oat]: 200 })
    const stronger = m('oat+', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: oat, withQty: 250, when: 'always' }])
    expect(obj(resolveRecipe(latte(), [stronger], false))[oat]).toBe(250)
  })
  it('remove takes some or all of an ingredient out, and never goes below zero', () => {
    expect(obj(resolveRecipe(latte(), [m('less', [{ ingredientId: milk, qty: 50, op: 'remove', when: 'always' }])], false))[milk]).toBe(150)
    expect(milk in obj(resolveRecipe(latte(), [m('none', [{ ingredientId: milk, qty: 0, op: 'remove', when: 'always' }])], false))).toBe(false)
    expect(milk in obj(resolveRecipe(latte(), [m('lots', [{ ingredientId: milk, qty: 999, op: 'remove', when: 'always' }])], false))).toBe(false)
  })
  it('a takeout-only add-on line (a sleeve) is skipped for dine-in', () => {
    const sleeve = m('sleeve', [L(cup, 1, { when: 'carry' })])
    expect(resolveRecipe([], [sleeve], false).size).toBe(0)
    expect(resolveRecipe([], [sleeve], true).get(cup)).toBe(1)
  })
})

describe('saving recipes', () => {
  let variantId = ''
  beforeEach(async () => {
    variantId = 'v1'
    await db.variants.add({ id: variantId, itemId: 'i1', size: '16 oz', temp: 'iced', price: 16800, active: true })
  })

  it('every save is a new version; saving the same recipe again changes nothing', async () => {
    const v1 = await saveRecipe('variant', variantId, latte(), 'u')
    expect(v1.version).toBe(1)
    expect((await saveRecipe('variant', variantId, latte(), 'u')).id).toBe(v1.id)
    const bigger = latte().map((l) => (l.ingredientId === beans ? { ...l, qty: 20 } : l)) // 18 g → 20 g
    const v2 = await saveRecipe('variant', variantId, bigger, 'u')
    expect(v2.version).toBe(2)
    expect((await currentRecipe('variant', variantId))?.id).toBe(v2.id)
    expect((await recipeHistory('variant', variantId)).map((r) => r.version)).toEqual([2, 1])
    expect((await db.recipes.get(v1.id))?.lines.find((l) => l.ingredientId === beans)?.qty).toBe(18) // the old sale's recipe is intact
  })
  it('checks the lines', async () => {
    await expect(saveRecipe('variant', variantId, [], 'u')).rejects.toThrow(/at least one/)
    await expect(saveRecipe('variant', variantId, [L('nope', 5)], 'u')).rejects.toThrow(/Pick an ingredient/)
    await expect(saveRecipe('variant', variantId, [L(beans, 0)], 'u')).rejects.toThrow(/more than 0/)
    await expect(saveRecipe('variant', variantId, [L(beans, 5), L(beans, 3)], 'u')).rejects.toThrow(/twice/)
    await expect(saveRecipe('variant', variantId, [{ ...L(beans, 5), op: 'remove' }], 'u')).rejects.toThrow(/only lists what goes in/)
    await expect(saveRecipe('variant', 'ghost', latte(), 'u')).rejects.toThrow(/not found/)
    await setIngredientActive(beans, false, 'u')
    await expect(saveRecipe('variant', variantId, latte(), 'u')).rejects.toThrow(/Pick an ingredient/) // an archived ingredient cannot be newly used
  })
  it('a replace needs something to replace with, not itself', async () => {
    await db.modifiers.add({ id: 'oat', groupId: 'g', name: 'Oat milk', price: 0, sizePrices: {}, freeQty: 0, maxQty: 1, soldOut: false, sort: 0, active: true })
    await expect(saveRecipe('modifier', 'oat', [{ ingredientId: milk, qty: 0, op: 'replace', when: 'always' }], 'u')).rejects.toThrow(/Pick what replaces/)
    await expect(saveRecipe('modifier', 'oat', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: milk, when: 'always' }], 'u')).rejects.toThrow(/itself/)
    await saveRecipe('modifier', 'oat', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: oat, when: 'always' }], 'u')
  })
})

describe('what a cart line deducts', () => {
  beforeEach(async () => {
    await db.variants.add({ id: 'v1', itemId: 'i1', size: '16 oz', temp: 'iced', price: 16800, active: true })
    for (const [id, name] of [['shot', 'Extra shot'], ['oat', 'Oat milk'], ['vanilla', 'Vanilla']]) {
      await db.modifiers.add({ id, groupId: 'g', name, price: 0, sizePrices: {}, freeQty: 0, maxQty: 4, soldOut: false, sort: 0, active: true })
    }
    await saveRecipe('variant', 'v1', latte(), 'u')
    await saveRecipe('modifier', 'shot', [L(beans, 9)], 'u')
    await saveRecipe('modifier', 'oat', [{ ingredientId: milk, qty: 0, op: 'replace', withIngredientId: oat, when: 'always' }], 'u')
    await saveRecipe('modifier', 'vanilla', [L(syrup, 10)], 'u')
  })
  const mod = (modifierId: string, qty = 1) => ({ modifierId, name: modifierId, qty, unit: 0, charge: 0 })

  it('2 takeout lattes with oat milk, an extra shot and 2 pumps of vanilla', async () => {
    const d = await deductionsForLine({ variantId: 'v1', qty: 2, mods: [mod('oat'), mod('shot'), mod('vanilla', 2)] }, 'takeout')
    expect(Object.fromEntries(d.uses.map((u) => [u.ingredientId, u.qty]))).toEqual({ [beans]: 54, [oat]: 400, [cup]: 2, [lid]: 2, [syrup]: 40 })
    expect(d.versions).toHaveLength(4)
  })
  it('dine-in drops the packaging; pickup counts as takeout', async () => {
    const dine = await deductionsForLine({ variantId: 'v1', qty: 1, mods: [] }, 'dine-in')
    expect(dine.uses.map((u) => u.ingredientId).sort()).toEqual([beans, milk].sort())
    expect((await deductionsForLine({ variantId: 'v1', qty: 1, mods: [] }, 'pickup')).uses).toHaveLength(4)
  })
  it('an item with no recipe deducts nothing instead of blocking the sale', async () => {
    expect(await deductionsForLine({ variantId: 'no-recipe', qty: 3, mods: [mod('unknown')] }, 'takeout')).toEqual({ uses: [], versions: [] })
  })
  it('a recipe change after a sale does not touch what that sale used (its version id is kept)', async () => {
    const before = await deductionsForLine({ variantId: 'v1', qty: 1, mods: [] }, 'dine-in')
    await saveRecipe('variant', 'v1', latte().map((l) => (l.ingredientId === beans ? { ...l, qty: 20 } : l)), 'u')
    const after = await deductionsForLine({ variantId: 'v1', qty: 1, mods: [] }, 'dine-in')
    expect(before.uses.find((u) => u.ingredientId === beans)?.qty).toBe(18)
    expect(after.uses.find((u) => u.ingredientId === beans)?.qty).toBe(20)
    expect(await db.recipes.get(before.versions[0])).toMatchObject({ version: 1 })
  })
})
