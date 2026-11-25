import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createCategory, createItem } from './db/menu'
import {
  createGroup, createModifier, getItemModifiers, setItemGroup, setModifierActive, setModifierSoldOut, updateModifier,
} from './db/modifiers'
import { formatSizePrices, parseSizePrices, quote, type GroupWithMods } from './lib/modifierPricing'
import { pesos } from './lib/money'

beforeEach(() => Promise.all(db.tables.map((t) => t.clear())))

const NONE = { sizePrices: {}, freeQty: 0, maxQty: 1 }

// Builds the groups used by most tests through the real db functions.
async function setup() {
  const item = await createItem((await createCategory('Espresso')).id, 'Latte')
  const milk = await createGroup({ name: 'Milk', min: 1, max: 1 })
  const dairy = await createModifier(milk.id, { name: 'Dairy', price: 0, ...NONE }, 'o')
  const oat = await createModifier(milk.id, { name: 'Oat', price: pesos(30), ...NONE, sizePrices: { '16 oz': pesos(40) } }, 'o')
  const syrup = await createGroup({ name: 'Syrups', min: 0, max: 2 })
  const vanilla = await createModifier(syrup.id, { name: 'Vanilla pumps', price: pesos(15), sizePrices: {}, freeQty: 1, maxQty: 4 }, 'o')
  const caramel = await createModifier(syrup.id, { name: 'Caramel', price: pesos(15), ...NONE }, 'o')
  await setItemGroup(item.id, milk.id, true)
  await setItemGroup(item.id, syrup.id, true)
  return { item, groups: await getItemModifiers(item.id), dairy, oat, vanilla, caramel }
}

describe('modifier pricing', () => {
  it('parses and formats size prices', () => {
    expect(parseSizePrices('12 oz: 30, 16 OZ : 40.50')).toEqual({ '12 oz': 3000, '16 oz': 4050 })
    expect(parseSizePrices('')).toEqual({})
    expect(parseSizePrices('12 oz 30')).toBeNull()
    expect(parseSizePrices('12 oz: abc')).toBeNull()
    expect(formatSizePrices({ '12 oz': 3000, '16 oz': 4050 })).toBe('12 oz: 30, 16 oz: 40.5')
  })
  it('oat milk is +₱30 on 12 oz and +₱40 on 16 oz', async () => {
    const { groups, oat } = await setup()
    expect(quote({ size: '12 oz', price: 12000 }, groups, [{ modifierId: oat.id, qty: 1 }]).total).toBe(12000 + 3000)
    expect(quote({ size: '16 oz', price: 14000 }, groups, [{ modifierId: oat.id, qty: 1 }]).total).toBe(14000 + 4000)
    expect(quote({ size: '8 oz', price: 10000 }, groups, [{ modifierId: oat.id, qty: 1 }]).modifierTotal).toBe(3000) // default
  })
  it('first syrup pump is free, then ₱15 each', async () => {
    const { groups, dairy, vanilla } = await setup()
    const q = (qty: number) => quote({ price: 10000 }, groups, [{ modifierId: dairy.id, qty: 1 }, { modifierId: vanilla.id, qty }])
    expect(q(1).modifierTotal).toBe(0)
    expect(q(3).modifierTotal).toBe(3000)
    expect(q(5).errors[0]).toMatch(/pick 1 to 4/)
  })
  it('a required group must be picked; ₱0 options are fine', async () => {
    const { groups, dairy } = await setup()
    expect(quote({ price: 10000 }, groups, []).errors).toEqual(['Milk: pick 1'])
    const ok = quote({ price: 10000 }, groups, [{ modifierId: dairy.id, qty: 1 }])
    expect(ok.ok).toBe(true)
    expect(ok.total).toBe(10000)
  })
  it('enforces group max, duplicates, unknown options', async () => {
    const { groups, dairy, oat } = await setup()
    expect(quote({ price: 1 }, groups, [{ modifierId: dairy.id, qty: 1 }, { modifierId: oat.id, qty: 1 }]).errors).toEqual(['Milk: pick at most 1'])
    expect(quote({ price: 1 }, groups, [{ modifierId: dairy.id, qty: 1 }, { modifierId: dairy.id, qty: 1 }]).errors[0]).toMatch(/twice/)
    expect(quote({ price: 1 }, groups, [{ modifierId: 'nope', qty: 1 }]).ok).toBe(false)
  })
  it('a sold-out option cannot be picked, and archived options disappear', async () => {
    const { item, oat, dairy } = await setup()
    await setModifierSoldOut(oat.id, true)
    let groups = await getItemModifiers(item.id)
    expect(quote({ price: 1 }, groups, [{ modifierId: oat.id, qty: 1 }]).errors).toContain('Oat is sold out')
    await setModifierActive('modifiers', oat.id, false)
    groups = await getItemModifiers(item.id)
    expect(groups[0].modifiers.map((m) => m.name)).toEqual(['Dairy'])
    expect(quote({ price: 1 }, groups, [{ modifierId: dairy.id, qty: 1 }]).ok).toBe(true)
  })
})

describe('modifier setup', () => {
  it('validates groups and options', async () => {
    await expect(createGroup({ name: 'X', min: 2, max: 1 })).rejects.toThrow()
    await expect(createGroup({ name: ' ', min: 0, max: 1 })).rejects.toThrow()
    const g = await createGroup({ name: 'Add-ons', min: 0, max: 3 })
    await expect(createGroup({ name: 'add-ons', min: 0, max: 1 })).rejects.toThrow(/already exists/)
    await expect(createModifier(g.id, { name: 'Shot', price: -1, ...NONE }, 'o')).rejects.toThrow()
    await expect(createModifier(g.id, { name: 'Shot', price: 1, sizePrices: {}, freeQty: 3, maxQty: 2 }, 'o')).rejects.toThrow()
    await createModifier(g.id, { name: 'Shot', price: 5000, ...NONE }, 'o')
    await expect(createModifier(g.id, { name: 'shot', price: 5000, ...NONE }, 'o')).rejects.toThrow(/already in this group/)
  })
  it('options keep their creation order and price changes are audited', async () => {
    const g = await createGroup({ name: 'Sugar', min: 1, max: 1 })
    const ids: string[] = []
    for (const n of ['0%', '25%', '50%', '75%', '100%']) ids.push((await createModifier(g.id, { name: n, price: 0, ...NONE }, 'o')).id)
    const item = await createItem((await createCategory('Tea')).id, 'Chai')
    await setItemGroup(item.id, g.id, true)
    expect((await getItemModifiers(item.id))[0].modifiers.map((m) => m.name)).toEqual(['0%', '25%', '50%', '75%', '100%'])
    await updateModifier(ids[0], { name: '0%', price: 0, ...NONE }, 'o') // no price change
    await updateModifier(ids[1], { name: '25%', price: 500, ...NONE }, 'o')
    expect((await db.auditLog.toArray()).filter((a) => a.action === 'modifier.price')).toHaveLength(1)
  })
  it('groups attach to and detach from items; archived groups are hidden', async () => {
    const item = await createItem((await createCategory('Tea')).id, 'Chai')
    const g = await createGroup({ name: 'Ice', min: 0, max: 1 })
    await setItemGroup(item.id, g.id, true)
    await setItemGroup(item.id, g.id, true)
    expect((await db.items.get(item.id))?.groupIds).toEqual([g.id])
    await setModifierActive('modifierGroups', g.id, false)
    expect(await getItemModifiers(item.id)).toEqual([])
    await setItemGroup(item.id, g.id, false)
    expect((await db.items.get(item.id))?.groupIds).toEqual([])
  })
  it('an item without add-ons returns none', async () => {
    const item = await createItem((await createCategory('Tea')).id, 'Plain')
    expect(await getItemModifiers(item.id)).toEqual([])
    const groups: GroupWithMods[] = []
    expect(quote({ price: 9000 }, groups, []).total).toBe(9000)
  })
})
