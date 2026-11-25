import { db } from './db'
import { margin, recipeCost } from '../lib/costs'
import { resolveRecipe } from '../lib/recipes'
import { getSetting } from './settings'
import { currentRecipe } from './recipes'
import { variantLabel } from './menu'

/**
 * Cost per drink and margin for every active size, from the CURRENT recipe and the CURRENT weighted average cost.
 * Dine-in leaves out the cup and lid; to-go includes them. A drink with no recipe, or an ingredient never received, shows "cost unknown".
 * (A sale keeps its own cost: see the unit cost on its stock movements.)
 */
export async function marginReport() {
  const [ingredients, items, variants, vat, target] = await Promise.all([
    db.ingredients.toArray(), db.items.filter((i) => i.active).toArray(), db.variants.filter((v) => v.active).toArray(), getSetting('vatRegistered'), getSetting('targetMarginPct'),
  ])
  const avg = new Map(ingredients.map((i) => [i.id, i.avgCostMilli]))
  const name = new Map(ingredients.map((i) => [i.id, i.name]))
  const rows = []
  for (const v of variants) {
    const item = items.find((i) => i.id === v.itemId)
    if (!item) continue
    const r = await currentRecipe('variant', v.id)
    const build = (carry: boolean) => {
      if (!r) return null
      const { cost, unknown } = recipeCost(resolveRecipe(r.lines, [], carry), avg)
      return { cost, unknown: unknown.map((id) => name.get(id) ?? '?'), ...margin(v.price, cost, vat) }
    }
    const dineIn = build(false)
    const toGo = build(true)
    rows.push({
      variantId: v.id, name: `${item.name} · ${variantLabel(v)}`, price: v.price, hasRecipe: !!r, dineIn, toGo,
      known: !!toGo && toGo.unknown.length === 0,
      below: !!toGo && toGo.unknown.length === 0 && Math.min(toGo.pct, dineIn?.pct ?? 100) < target,
    })
  }
  return { target, rows: rows.sort((a, b) => a.name.localeCompare(b.name)) }
}

/** Drinks that use any of these ingredients and are now under the target margin (for the "supplier raised prices" alert). */
export async function lowMarginsFor(ingredientIds: string[]) {
  const { rows } = await marginReport()
  const used = new Set<string>()
  for (const r of await db.recipes.filter((x) => x.kind === 'variant' && x.lines.some((l) => ingredientIds.includes(l.ingredientId))).toArray()) used.add(r.refId)
  return rows.filter((r) => r.below && used.has(r.variantId))
}

