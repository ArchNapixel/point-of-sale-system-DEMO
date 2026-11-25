import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { addUnit, createIngredient, renameIngredient, setIngredientActive, setUnitActive, setUnitFactor } from './db/ingredients'
import { formatQty, fromBase, toBase } from './lib/units'

beforeEach(() => Promise.all(db.tables.map((t) => t.clear())))

describe('unit conversions', () => {
  it('beans: a 1 kg bag is 1,000 g; milk: a case of 12 × 1 L is 12,000 ml; syrup: 2 pumps is 20 ml', async () => {
    const beans = await createIngredient('Espresso beans', 'g', 'u')
    expect(toBase(beans, 1, 'kg')).toBe(1000)
    expect(toBase(beans, 18, 'g')).toBe(18)
    const milk = await createIngredient('Milk', 'ml', 'u')
    await addUnit(milk.id, 'case', 12000, 'u')
    const syrup = await createIngredient('Vanilla syrup', 'ml', 'u')
    await addUnit(syrup.id, 'pump', 10, 'u')
    const m = (await db.ingredients.get(milk.id))!
    const s = (await db.ingredients.get(syrup.id))!
    expect(toBase(m, 1, 'case')).toBe(12000)
    expect(toBase(m, 1, 'L')).toBe(1000)
    expect(toBase(s, 2, 'pump')).toBe(20)
    expect(toBase(s, 0.5, 'PUMP')).toBe(5) // fractions work, any capitals
  })
  it('converts back and reads well on screen', async () => {
    const milk = await createIngredient('Milk', 'ml', 'u')
    expect(fromBase(milk, 12500, 'L')).toBe(12.5)
    expect(formatQty(milk, 12500)).toBe('12.5 L')
    expect(formatQty(milk, 800)).toBe('800 ml')
    expect(formatQty(milk, -2500)).toBe('-2.5 L') // negative stock is allowed and shows plainly
  })
  it('a unit the ingredient does not have is an error, and a switched-off unit is not suggested', async () => {
    const milk = await createIngredient('Milk', 'ml', 'u')
    expect(() => toBase(milk, 1, 'case')).toThrow(/no unit called "case"/)
    await setUnitActive(milk.id, 'L', false, 'u')
    expect(formatQty((await db.ingredients.get(milk.id))!, 2000)).toBe('2000 ml')
  })
  it('rounds to 3 decimals so fractions do not drift', async () => {
    const syrup = await createIngredient('Syrup', 'ml', 'u')
    await addUnit(syrup.id, 'drop', 0.05, 'u')
    expect(toBase((await db.ingredients.get(syrup.id))!, 3, 'drop')).toBe(0.15)
  })
})

describe('ingredients', () => {
  it('starts with the common unit for its base: kg for g, L for ml, dozen for pcs', async () => {
    expect((await createIngredient('Beans', 'g', 'u')).units.map((u) => [u.name, u.factor])).toEqual([['kg', 1000]])
    expect((await createIngredient('Milk', 'ml', 'u')).units.map((u) => [u.name, u.factor])).toEqual([['L', 1000]])
    expect((await createIngredient('Eggs', 'pcs', 'u')).units.map((u) => [u.name, u.factor])).toEqual([['dozen', 12]])
  })
  it('checks the form', async () => {
    await expect(createIngredient(' ', 'g', 'u')).rejects.toThrow(/name/)
    await expect(createIngredient('Beans', 'kg' as never, 'u')).rejects.toThrow(/g, ml or pcs/)
    const beans = await createIngredient('Beans', 'g', 'u')
    await expect(createIngredient('BEANS', 'g', 'u')).rejects.toThrow(/already exists/)
    await expect(addUnit(beans.id, 'g', 1, 'u')).rejects.toThrow(/already the base unit/)
    await expect(addUnit(beans.id, 'KG', 1000, 'u')).rejects.toThrow(/already exists/)
    await expect(addUnit(beans.id, 'bag', 0, 'u')).rejects.toThrow(/more than 0/)
    await expect(addUnit(beans.id, 'bag', Number.NaN, 'u')).rejects.toThrow(/more than 0/)
    await expect(addUnit(beans.id, ' ', 5, 'u')).rejects.toThrow(/Unit name/)
  })
  it('changing a conversion and archiving are audited; nothing is deleted', async () => {
    const beans = await createIngredient('Beans', 'g', 'u')
    await setUnitFactor(beans.id, 'kg', 1010, 'u')
    await renameIngredient(beans.id, 'House beans', 'u')
    await setIngredientActive(beans.id, false, 'u')
    expect(await db.ingredients.get(beans.id)).toMatchObject({ name: 'House beans', active: false, units: [{ name: 'kg', factor: 1010 }] })
    expect((await db.auditLog.where('action').equals('ingredient.unit.change').first())?.detail).toMatchObject({ from: 1000, to: 1010 })
    expect(await db.auditLog.where('action').equals('ingredient.archive').count()).toBe(1)
    await setIngredientActive(beans.id, true, 'u')
    expect((await db.ingredients.get(beans.id))?.active).toBe(true)
  })
})
