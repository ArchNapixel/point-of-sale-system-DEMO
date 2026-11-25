import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import {
  createCategory, createItem, createVariant, getSellableMenu, setMenuActive, setSoldOut, updateVariant, variantLabel,
} from './db/menu'
import { parsePesos, pesos } from './lib/money'

beforeEach(() => Promise.all(db.tables.map((t) => t.clear())))

describe('menu', () => {
  it('parses typed peso amounts', () => {
    expect(parsePesos('168')).toBe(16800)
    expect(parsePesos('33.60')).toBe(3360)
    expect(parsePesos('0')).toBe(0)
    expect(parsePesos('')).toBeNull()
    expect(parsePesos('-5')).toBeNull()
    expect(parsePesos('1.234')).toBeNull()
    expect(parsePesos('abc')).toBeNull()
  })
  it('labels variants', () => {
    expect(variantLabel({ size: '16 oz', temp: 'iced' })).toBe('16 oz · Iced')
    expect(variantLabel({ temp: 'hot' })).toBe('Hot')
    expect(variantLabel({})).toBe('Regular')
  })
  it('rejects duplicate categories, items and variants', async () => {
    const c = await createCategory('Espresso')
    await expect(createCategory(' espresso ')).rejects.toThrow(/already exists/)
    const i = await createItem(c.id, 'Latte')
    await expect(createItem(c.id, 'latte')).rejects.toThrow(/already in this category/)
    await createVariant(i.id, { size: '16 oz', temp: 'iced', price: pesos(168) }, 'u')
    await expect(createVariant(i.id, { size: '16 OZ', temp: 'iced', price: pesos(150) }, 'u')).rejects.toThrow(/already exists/)
    await createVariant(i.id, { size: '16 oz', temp: 'hot', price: pesos(160) }, 'u')
  })
  it('price must be integer centavos, zero allowed (hot water)', async () => {
    const i = await createItem((await createCategory('Free')).id, 'Hot water')
    await expect(createVariant(i.id, { price: 1.5 }, 'u')).rejects.toThrow()
    await expect(createVariant(i.id, { price: -1 }, 'u')).rejects.toThrow()
    expect((await createVariant(i.id, { price: 0 }, 'u')).price).toBe(0)
  })
  it('price changes are audited, other edits are not', async () => {
    const i = await createItem((await createCategory('Espresso')).id, 'Latte')
    const v = await createVariant(i.id, { size: '12 oz', price: 14000 }, 'owner')
    await updateVariant(v.id, { size: '12 oz', price: 15000 }, 'owner')
    await updateVariant(v.id, { size: '12 oz', price: 15000 }, 'owner')
    const log = (await db.auditLog.toArray()).filter((a) => a.action === 'variant.price')
    expect(log).toHaveLength(1)
    expect(log[0].detail).toEqual({ from: 14000, to: 15000 })
  })
  it('sellable menu hides archived and empty things but keeps sold-out items', async () => {
    const espresso = await createCategory('Espresso')
    const tea = await createCategory('Tea')
    await createCategory('Empty')
    const latte = await createItem(espresso.id, 'Latte')
    const mocha = await createItem(espresso.id, 'Mocha') // no variants yet
    const chai = await createItem(tea.id, 'Chai')
    const lv = await createVariant(latte.id, { size: '12 oz', price: 12000 }, 'u')
    await createVariant(latte.id, { size: '16 oz', price: 14000 }, 'u')
    await createVariant(chai.id, { price: 9000 }, 'u')
    await setSoldOut(latte.id, true)
    await setMenuActive('variants', lv.id, false)

    let menu = await getSellableMenu()
    expect(menu.map((c) => c.name)).toEqual(['Espresso', 'Tea'])
    const l = menu[0].items.find((i) => i.name === 'Latte')!
    expect(l.soldOut).toBe(true)
    expect(l.variants.map((v) => v.size)).toEqual(['16 oz'])
    expect(menu[0].items.some((i) => i.id === mocha.id)).toBe(false)

    await setMenuActive('categories', tea.id, false)
    menu = await getSellableMenu()
    expect(menu.map((c) => c.name)).toEqual(['Espresso'])
    expect(await db.items.get(chai.id)).toBeTruthy() // archived, not deleted
  })
})
