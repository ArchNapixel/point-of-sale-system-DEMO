import type { quote } from './modifierPricing'
import type { StatutoryInput } from './discount'

export type OrderType = 'dine-in' | 'takeout' | 'pickup'
export const ORDER_TYPES: { id: OrderType; label: string }[] = [
  { id: 'dine-in', label: 'Dine-in' },
  { id: 'takeout', label: 'Takeout' },
  { id: 'pickup', label: 'Pickup' },
]

export type CartMod = { modifierId: string; name: string; qty: number; unit: number; charge: number }
/** A line is a snapshot: names and prices are copied in when it's added, so later menu edits never change it (rule 2). */
export type CartLine = {
  id: string
  itemId: string
  variantId: string
  name: string
  variantLabel: string
  basePrice: number
  mods: CartMod[]
  notes: string[] // quick chips: "Less ice", "Extra hot"
  allergy: string // free text; printed loudly on the bar ticket (1J)
  qty: number
  comp?: { code: string; note: string } // free on purpose: priced at ₱0, the value is kept as a comp
  addedAt?: string // when the item was added: a promo window is judged at this time, not at payment
}
export type Cart = { orderType: OrderType; name: string; table: string; lines: CartLine[]; discount?: StatutoryInput; promoCode?: string; employee?: { id: string; name: string }; deliveryFee?: number; channelId?: string }

// ponytail: a repeat add of the same drink merges into the first line and keeps the first add time, so a re-add after a promo
// window boundary is judged by the earlier time. Split lines by minute if that ever matters.
export const MAX_QTY = 99
export const emptyCart = (): Cart => ({ orderType: 'takeout', name: '', table: '', lines: [] })

export const lineUnit = (l: CartLine) => l.basePrice + l.mods.reduce((s, m) => s + m.charge, 0)
export const lineTotal = (l: CartLine) => (l.comp ? 0 : lineUnit(l) * l.qty)
/** What a comped line would have cost. */
export const compValue = (l: CartLine) => (l.comp ? lineUnit(l) * l.qty : 0)
export const compTotal = (c: Cart) => c.lines.reduce((s, l) => s + compValue(l), 0)
export const cartTotal = (c: Cart) => c.lines.reduce((s, l) => s + lineTotal(l), 0)
export const cartCount = (c: Cart) => c.lines.reduce((s, l) => s + l.qty, 0)

/** Two lines with the same key are the same drink and can merge into one line with a higher quantity. */
const configKey = (l: CartLine) =>
  JSON.stringify([
    l.variantId,
    l.mods.map((m) => `${m.modifierId}:${m.qty}`).sort(),
    [...l.notes].sort(),
    l.allergy.trim().toLowerCase(),
    l.comp ?? null,
  ])

export function buildLine(
  id: string,
  item: { id: string; name: string },
  variant: { id: string; price: number },
  variantLabel: string,
  q: ReturnType<typeof quote>,
  notes: string[],
  allergy: string,
  qty = 1,
): CartLine {
  return {
    id,
    itemId: item.id,
    variantId: variant.id,
    name: item.name,
    variantLabel,
    basePrice: variant.price,
    mods: q.lines.map(({ modifierId, name, qty, unit, charge }) => ({ modifierId, name, qty, unit, charge })),
    notes,
    allergy: allergy.trim(),
    qty,
    addedAt: new Date().toISOString(),
  }
}

const withLines = (c: Cart, lines: CartLine[]): Cart => ({ ...c, lines })

export function addLine(c: Cart, line: CartLine): Cart {
  const same = c.lines.find((l) => configKey(l) === configKey(line))
  if (!same) return withLines(c, [...c.lines, line])
  return withLines(c, c.lines.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l)))
}

/** +1 / -1. Going to 0 removes the line. */
export function changeQty(c: Cart, id: string, delta: number): Cart {
  return withLines(
    c,
    c.lines.flatMap((l) => {
      if (l.id !== id) return [l]
      const qty = Math.min(MAX_QTY, l.qty + delta)
      return qty <= 0 ? [] : [{ ...l, qty }]
    }),
  )
}

export const removeLine = (c: Cart, id: string): Cart => withLines(c, c.lines.filter((l) => l.id !== id))

/** Copies a line (quantity 1) right below the original, as its own line to edit. */
export function duplicateLine(c: Cart, id: string, newId: string): Cart {
  const i = c.lines.findIndex((l) => l.id === id)
  if (i < 0) return c
  const copy = { ...c.lines[i], id: newId, qty: 1 }
  return withLines(c, [...c.lines.slice(0, i + 1), copy, ...c.lines.slice(i + 1)])
}

/** Swaps a line's drink/add-ons/notes, keeping its place, id and quantity. */
export const replaceLine = (c: Cart, id: string, line: CartLine): Cart =>
  withLines(c, c.lines.map((l) => (l.id === id ? { ...line, id, qty: l.qty } : l)))
