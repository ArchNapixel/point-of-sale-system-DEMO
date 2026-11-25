import { db, type Recipe } from './db'
import { newId } from '../lib/id'
import { checkLines, isCarry, resolveRecipe, type RecipeLine } from '../lib/recipes'
import type { CartLine } from '../lib/cart'
import { audit } from './audit'

export type RecipeKind = 'variant' | 'modifier'

/** The newest version of a variant's or an add-on's recipe, if it has one. */
export async function currentRecipe(kind: RecipeKind, refId: string): Promise<Recipe | undefined> {
  const all = await db.recipes.where('refId').equals(refId).toArray()
  return all.filter((r) => r.kind === kind).sort((a, b) => b.version - a.version)[0]
}

export async function recipeHistory(kind: RecipeKind, refId: string): Promise<Recipe[]> {
  return (await db.recipes.where('refId').equals(refId).toArray()).filter((r) => r.kind === kind).sort((a, b) => b.version - a.version)
}

const same = (a: RecipeLine[], b: RecipeLine[]) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Saves a recipe as a new version (the old one is kept, so old sales keep their cost and what they deducted).
 * Saving what is already current changes nothing.
 */
export async function saveRecipe(kind: RecipeKind, refId: string, lines: RecipeLine[], userId: string): Promise<Recipe> {
  const target = kind === 'variant' ? await db.variants.get(refId) : await db.modifiers.get(refId)
  if (!target) throw new Error(kind === 'variant' ? 'Size or price not found' : 'Add-on not found')
  const active = new Map((await db.ingredients.toArray()).map((i) => [i.id, i.active]))
  checkLines(kind, lines, (id) => active.get(id) === true)
  const cur = await currentRecipe(kind, refId)
  if (cur && same(cur.lines, lines)) return cur
  const r: Recipe = { id: newId(), kind, refId, version: (cur?.version ?? 0) + 1, lines, at: new Date().toISOString(), by: userId }
  await db.recipes.add(r)
  await audit({ userId, action: 'recipe.save', ref: refId, detail: { kind, version: r.version, lines: lines.length } })
  return r
}

/**
 * What one cart line uses up in base units, from the CURRENT recipes (3C stores the version ids with each stock movement).
 * Dine-in skips takeout-only lines (paper cup, lid). A drink or add-on with no recipe uses nothing, so a half-finished
 * setup never blocks a sale.
 */
export async function deductionsForLine(line: Pick<CartLine, 'variantId' | 'mods' | 'qty'>, orderType: string) {
  const base = await currentRecipe('variant', line.variantId)
  const mods = await Promise.all(line.mods.map(async (m) => ({ recipe: await currentRecipe('modifier', m.modifierId), qty: m.qty })))
  const use = resolveRecipe(base?.lines ?? [], mods.flatMap((m) => (m.recipe ? [{ lines: m.recipe.lines, qty: m.qty }] : [])), isCarry(orderType))
  return {
    uses: [...use].map(([ingredientId, qty]) => ({ ingredientId, qty: Math.round(qty * line.qty * 1000) / 1000 })),
    versions: [base, ...mods.map((m) => m.recipe)].flatMap((r) => (r ? [r.id] : [])),
  }
}
