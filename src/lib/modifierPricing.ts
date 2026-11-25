import type { Modifier, ModifierGroup } from '../db/db'

export type GroupWithMods = ModifierGroup & { modifiers: Modifier[] }
export type Selection = { modifierId: string; qty: number }

export const sizeKey = (size?: string) => (size ?? '').trim().toLowerCase()

/** Price of one unit of a modifier for a drink size: a size-specific price wins over the default. */
export const modifierUnitPrice = (m: Pick<Modifier, 'price' | 'sizePrices'>, size?: string): number =>
  m.sizePrices[sizeKey(size)] ?? m.price

/** "12 oz: 30, 16 oz: 40" -> { "12 oz": 3000, "16 oz": 4000 }. Returns null if any part is invalid. */
export function parseSizePrices(text: string): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*:\s*(\d+(?:\.\d{1,2})?)$/.exec(part)
    if (!m) return null
    out[sizeKey(m[1])] = Math.round(Number(m[2]) * 100)
  }
  return out
}

export const formatSizePrices = (sp: Record<string, number>): string =>
  Object.entries(sp).map(([s, c]) => `${s}: ${c / 100}`).join(', ')

/**
 * Prices a drink with its chosen add-ons and checks the group rules.
 * `groups` must hold only the item's active groups and their active options.
 * Money is integer centavos. A sold-out option can't be picked.
 */
export function quote(variant: { size?: string; price: number }, groups: GroupWithMods[], selections: Selection[]) {
  const errors: string[] = []
  const lines: { modifierId: string; name: string; qty: number; unit: number; charge: number }[] = []
  const byId = new Map(groups.flatMap((g) => g.modifiers.map((m) => [m.id, { m, g }] as const)))
  const picked = new Map<string, number>() // group id -> distinct options picked
  const seen = new Set<string>()

  for (const sel of selections) {
    const hit = byId.get(sel.modifierId)
    if (!hit) { errors.push('An option is not available for this item'); continue }
    const { m, g } = hit
    if (seen.has(m.id)) { errors.push(`${m.name} was picked twice`); continue }
    seen.add(m.id)
    if (!Number.isInteger(sel.qty) || sel.qty < 1 || sel.qty > m.maxQty) { errors.push(`${m.name}: pick 1 to ${m.maxQty}`); continue }
    if (m.soldOut) { errors.push(`${m.name} is sold out`); continue }
    picked.set(g.id, (picked.get(g.id) ?? 0) + 1)
    const unit = modifierUnitPrice(m, variant.size)
    lines.push({ modifierId: m.id, name: m.name, qty: sel.qty, unit, charge: unit * Math.max(0, sel.qty - m.freeQty) })
  }
  for (const g of groups) {
    const n = picked.get(g.id) ?? 0
    if (n < g.min) errors.push(`${g.name}: pick ${g.min === 1 ? '1' : `at least ${g.min}`}`)
    if (n > g.max) errors.push(`${g.name}: pick at most ${g.max}`)
  }
  const modifierTotal = lines.reduce((s, l) => s + l.charge, 0)
  return { lines, modifierTotal, total: variant.price + modifierTotal, errors, ok: errors.length === 0 }
}
