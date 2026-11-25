import { db, type Ingredient } from './db'
import { newId } from '../lib/id'
import { BASE_UNITS, PRESET_UNIT, type BaseUnit } from '../lib/units'
import { audit } from './audit'

const clean = (s: string) => s.trim()

function checkUnit(ing: Ingredient, name: string, factor: number, exceptName?: string) {
  const n = clean(name)
  if (!n) throw new Error('Unit name is required')
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Enter how many base units make 1 of this unit (more than 0)')
  if (n.toLowerCase() === ing.baseUnit) throw new Error(`${ing.baseUnit} is already the base unit`)
  if (ing.units.some((u) => u.name.toLowerCase() === n.toLowerCase() && u.name !== exceptName)) throw new Error(`"${n}" already exists for ${ing.name}`)
  return n
}

/** Creates an ingredient with its base unit and the common conversion (kg, L or dozen). */
export async function createIngredient(name: string, baseUnit: BaseUnit, userId: string): Promise<Ingredient> {
  const n = clean(name)
  if (!n) throw new Error('Ingredient name is required')
  if (!BASE_UNITS.includes(baseUnit)) throw new Error('Pick g, ml or pcs')
  if ((await db.ingredients.toArray()).some((i) => i.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  const ing: Ingredient = { id: newId(), name: n, baseUnit, units: [{ ...PRESET_UNIT[baseUnit], active: true }], active: true }
  await db.ingredients.add(ing)
  await audit({ userId, action: 'ingredient.create', ref: ing.id, detail: { name: n, baseUnit } })
  return ing
}

/** "1 pump = 10 ml", "1 case = 12000 ml". Stock moves keep their base quantity, so later changes never rewrite history. */
export async function addUnit(ingredientId: string, name: string, factor: number, userId: string) {
  const ing = await db.ingredients.get(ingredientId)
  if (!ing) throw new Error('Ingredient not found')
  const n = checkUnit(ing, name, factor)
  await db.ingredients.update(ingredientId, { units: [...ing.units, { name: n, factor, active: true }] })
  await audit({ userId, action: 'ingredient.unit.add', ref: ingredientId, detail: { unit: n, factor, baseUnit: ing.baseUnit } })
}

export async function setUnitFactor(ingredientId: string, unit: string, factor: number, userId: string) {
  const ing = await db.ingredients.get(ingredientId)
  const u = ing?.units.find((x) => x.name === unit)
  if (!ing || !u) throw new Error('Unit not found')
  checkUnit(ing, unit, factor, unit)
  await db.ingredients.update(ingredientId, { units: ing.units.map((x) => (x === u ? { ...x, factor } : x)) })
  await audit({ userId, action: 'ingredient.unit.change', ref: ingredientId, detail: { unit, from: u.factor, to: factor } })
}

/** Switch a unit off (kept for history) or back on. */
export async function setUnitActive(ingredientId: string, unit: string, active: boolean, userId: string) {
  const ing = await db.ingredients.get(ingredientId)
  if (!ing?.units.some((x) => x.name === unit)) throw new Error('Unit not found')
  await db.ingredients.update(ingredientId, { units: ing.units.map((x) => (x.name === unit ? { ...x, active } : x)) })
  await audit({ userId, action: active ? 'ingredient.unit.on' : 'ingredient.unit.off', ref: ingredientId, detail: { unit } })
}

export async function renameIngredient(id: string, name: string, userId: string) {
  const n = clean(name)
  if (!n) throw new Error('Ingredient name is required')
  if ((await db.ingredients.toArray()).some((i) => i.id !== id && i.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  await db.ingredients.update(id, { name: n })
  await audit({ userId, action: 'ingredient.rename', ref: id, detail: { name: n } })
}

/** Archive or restore. Recipes and stock history keep pointing at it. */
export async function setIngredientActive(id: string, active: boolean, userId: string) {
  await db.ingredients.update(id, { active })
  await audit({ userId, action: active ? 'ingredient.restore' : 'ingredient.archive', ref: id })
}
