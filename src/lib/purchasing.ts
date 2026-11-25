import type { Ingredient } from '../db/db'

/** 'YYYY-MM-DD' plus days, computed on the calendar (not by adding 24 h) so daylight saving never shifts it. */
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/**
 * Weighted average cost, in thousandths of a centavo per base unit.
 * (stock on hand × old average + received × invoice unit cost) ÷ (both). The first receipt sets the average outright.
 */
export function newAverageMilli(onHand: number, oldAvgMilli: number | undefined, received: number, unitCostMilli: number) {
  if (onHand <= 0 || oldAvgMilli === undefined) return unitCostMilli
  return Math.round((onHand * oldAvgMilli + received * unitCostMilli) / (onHand + received))
}

/** Par levels turn into a suggested order: the gap between what should be there and what is, never counting negative stock as a hole. */
export function suggestOrder(ingredients: Pick<Ingredient, 'id' | 'par'>[], level: Map<string, number>) {
  return ingredients.flatMap((i) => {
    const gap = (i.par ?? 0) - Math.max(0, level.get(i.id) ?? 0)
    return gap > 0 ? [{ ingredientId: i.id, qty: Math.round(gap * 1000) / 1000 }] : []
  })
}

/** Cost of a quantity of an ingredient, in whole centavos. */
export const costOf = (qty: number, avgCostMilli: number | undefined) => Math.round((qty * (avgCostMilli ?? 0)) / 1000)
