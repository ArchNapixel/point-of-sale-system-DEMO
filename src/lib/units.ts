// Stock is counted in a base unit per ingredient (g, ml or pcs). Other units (kg, pump, case) convert to it by a factor.
// Quantities are plain numbers rounded to 3 decimals (1 pump = 10 ml, 0.5 pump = 5 ml). Money never uses this.
export type BaseUnit = 'g' | 'ml' | 'pcs'
export const BASE_UNITS: BaseUnit[] = ['g', 'ml', 'pcs']
export type IngredientUnit = { name: string; factor: number; active: boolean } // 1 of this unit = factor base units

/** Added automatically when an ingredient is created, so the common conversion is there from the start. */
export const PRESET_UNIT: Record<BaseUnit, { name: string; factor: number }> = {
  g: { name: 'kg', factor: 1000 },
  ml: { name: 'L', factor: 1000 },
  pcs: { name: 'dozen', factor: 12 },
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

type WithUnits = { baseUnit: BaseUnit; units: IngredientUnit[] }

const find = (ing: WithUnits, unit: string) => ing.units.find((u) => u.name.toLowerCase() === unit.trim().toLowerCase())

/** Amount in a unit → base units. "2 pump" → 20 ml. The base unit itself has factor 1. */
export function toBase(ing: WithUnits, qty: number, unit: string): number {
  if (!Number.isFinite(qty)) throw new Error('Enter a number')
  if (unit.trim().toLowerCase() === ing.baseUnit) return round3(qty)
  const u = find(ing, unit)
  if (!u) throw new Error(`This ingredient has no unit called "${unit}"`)
  return round3(qty * u.factor)
}

/** Base units → a unit. 12000 ml → 12 L. */
export function fromBase(ing: WithUnits, base: number, unit: string): number {
  if (unit.trim().toLowerCase() === ing.baseUnit) return round3(base)
  const u = find(ing, unit)
  if (!u) throw new Error(`This ingredient has no unit called "${unit}"`)
  return round3(base / u.factor)
}

/** Reads well on screen: the biggest active unit that gives 1 or more, else the base unit. 12500 ml → "12.5 L". */
export function formatQty(ing: WithUnits, base: number): string {
  const big = ing.units.filter((u) => u.active && u.factor > 1 && Math.abs(base) >= u.factor).sort((a, b) => b.factor - a.factor)[0]
  return big ? `${round3(base / big.factor)} ${big.name}` : `${round3(base)} ${ing.baseUnit}`
}
