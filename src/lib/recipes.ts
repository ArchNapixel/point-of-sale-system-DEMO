// A recipe says which ingredients one sale uses up. Quantities are in each ingredient's base unit (g, ml, pcs).
//  - A variant's recipe: lines that are always 'add' (18 g beans, 200 ml milk, 1 cup).
//  - A modifier's recipe: deltas that change the variant's recipe: add (extra shot +9 g), remove (no foam), replace (oat for milk).
// Every save makes a new version, so old sales keep the recipe they were made with.
export type RecipeLine = {
  ingredientId: string
  qty: number // add: amount (per unit of the modifier). remove: amount to take out. replace: unused. 0 on remove/replace = the whole ingredient
  op: 'add' | 'remove' | 'replace'
  withIngredientId?: string // replace: what goes in instead
  withQty?: number // replace: how much of it; missing = the same amount that was taken out
  when: 'always' | 'carry' // 'carry' = only for takeout and pickup (paper cup, lid, straw). Dine-in uses a mug.
}

export const isCarry = (orderType: string) => orderType !== 'dine-in'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * What one drink uses: its recipe, then each add-on's deltas in the order they were picked.
 * add scales with how many of that add-on were picked (2 pumps); remove and replace apply once.
 * Replace takes the ingredient out entirely and puts the new one in. Nothing goes below zero.
 */
export function resolveRecipe(base: RecipeLine[], mods: { lines: RecipeLine[]; qty: number }[], carry: boolean): Map<string, number> {
  const use = new Map<string, number>()
  const on = (l: RecipeLine) => l.when === 'always' || carry
  const add = (id: string, q: number) => use.set(id, round3((use.get(id) ?? 0) + q))
  for (const l of base) if (on(l)) add(l.ingredientId, l.qty)
  for (const m of mods) {
    for (const l of m.lines) {
      if (!on(l)) continue
      if (l.op === 'add') add(l.ingredientId, l.qty * m.qty)
      else if (l.op === 'remove') {
        const left = l.qty === 0 ? 0 : (use.get(l.ingredientId) ?? 0) - l.qty
        if (left > 0) use.set(l.ingredientId, round3(left))
        else use.delete(l.ingredientId)
      } else {
        const taken = use.get(l.ingredientId) ?? 0
        use.delete(l.ingredientId)
        if (l.withIngredientId) add(l.withIngredientId, l.withQty ?? taken)
      }
    }
  }
  for (const [k, v] of use) if (v <= 0) use.delete(k)
  return use
}

/** Checks a recipe before it is saved. Throws a message the owner can act on. */
export function checkLines(kind: 'variant' | 'modifier', lines: RecipeLine[], knownIngredient: (id: string) => boolean) {
  if (lines.length === 0) throw new Error('Add at least one ingredient')
  const seen = new Set<string>()
  for (const l of lines) {
    if (!knownIngredient(l.ingredientId)) throw new Error('Pick an ingredient for every row')
    if (!Number.isFinite(l.qty) || l.qty < 0 || (l.qty === 0 && l.op === 'add')) throw new Error('Enter an amount more than 0')
    if (kind === 'variant' && l.op !== 'add') throw new Error('A drink recipe only lists what goes in; changes belong to add-ons')
    if (l.op === 'replace') {
      if (!l.withIngredientId || !knownIngredient(l.withIngredientId)) throw new Error('Pick what replaces it')
      if (l.withIngredientId === l.ingredientId) throw new Error('An ingredient cannot replace itself')
      if (l.withQty !== undefined && (!Number.isFinite(l.withQty) || l.withQty <= 0)) throw new Error('Enter the replacement amount')
    }
    const key = `${l.ingredientId}|${l.op}|${l.when}`
    if (seen.has(key)) throw new Error('The same ingredient is listed twice. Combine the amounts.')
    seen.add(key)
  }
}
