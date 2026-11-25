import { lineUnit, type Cart, type CartLine } from './cart'

// Promos are demo rules the owner enters by hand. Money is integer centavos; every percentage is rounded per line, half-up.
export type PromoKind = 'percent' | 'amount' | 'b1t1'
export type Promo = {
  id: string
  name: string
  kind: PromoKind
  value: number // percent (0-100) for 'percent', centavos for 'amount', unused for 'b1t1'
  minSpend: number // centavos; 0 = none. Re-checked on every cart change, so a promo drops off by itself when the cart falls below it
  days: number[] // 0 = Sunday … 6 = Saturday; empty = every day
  from: string // 'HH:MM' start of the daily window, '' = all day
  to: string // 'HH:MM' end (exclusive)
  startDate: string // 'YYYY-MM-DD', '' = no start
  endDate: string // last valid date (inclusive), '' = never expires
  appliesToMods: boolean // does a % promo also take off add-ons (extra shot)?
  code: string // when set the cashier must type it; uppercase
  maxUses: number // total times a code may be used; 0 = unlimited. 1 = single-use voucher
  active: boolean
}

export type Reduction = { total: number; lines: { lineId: string; amount: number }[] }

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
export const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Is the promo running at this moment? Each item is judged at the time it was added (a 4:58 add still gets the 5:00 happy hour). */
export function inWindow(p: Promo, at: Date): boolean {
  if (p.days.length > 0 && !p.days.includes(at.getDay())) return false
  if (p.startDate && ymdLocal(at) < p.startDate) return false
  if (p.endDate && ymdLocal(at) > p.endDate) return false
  if (p.from && hhmm(at) < p.from) return false
  if (p.to && hhmm(at) >= p.to) return false
  return true
}

const addedAt = (l: CartLine, now: Date) => (l.addedAt ? new Date(l.addedAt) : now)
const totalOf = (lines: Reduction['lines']): Reduction | null => {
  const total = lines.reduce((s, l) => s + l.amount, 0)
  return total > 0 ? { total, lines: lines.filter((l) => l.amount > 0) } : null
}

/** What this promo takes off the cart right now, or null if it does not apply (outside its window, below the minimum spend, nothing eligible). */
export function promoReduction(p: Promo, cart: Cart, now: Date): Reduction | null {
  const eligible = cart.lines.filter((l) => !l.comp && inWindow(p, addedAt(l, now)))
  const spend = eligible.reduce((s, l) => s + lineUnit(l) * l.qty, 0)
  if (eligible.length === 0 || spend < p.minSpend) return null
  if (p.kind === 'percent') {
    return totalOf(eligible.map((l) => ({ lineId: l.id, amount: Math.round(((p.appliesToMods ? lineUnit(l) : l.basePrice) * l.qty * p.value) / 100) })))
  }
  if (p.kind === 'amount') {
    const off = Math.min(p.value, spend)
    // Share it across the eligible lines in proportion to their price; the last line takes the rounding remainder.
    let left = off
    return totalOf(eligible.map((l, i) => {
      const share = i === eligible.length - 1 ? left : Math.round((off * lineUnit(l) * l.qty) / spend)
      left -= share
      return { lineId: l.id, amount: share }
    }))
  }
  // Buy 1 Take 1: line up every unit from dearest to cheapest and pair them off; the cheaper of each pair is free.
  const units = eligible.flatMap((l) => Array.from({ length: l.qty }, () => ({ lineId: l.id, price: lineUnit(l) }))).sort((a, b) => b.price - a.price)
  const free = new Map<string, number>()
  for (let i = 1; i < units.length; i += 2) free.set(units[i].lineId, (free.get(units[i].lineId) ?? 0) + units[i].price)
  return totalOf([...free].map(([lineId, amount]) => ({ lineId, amount })))
}

/** Staff discount: a flat percent off every paid line (add-ons included). Never stacked with Senior/PWD (see priceCart). */
export function employeeReduction(pct: number, cart: Cart): Reduction | null {
  return totalOf(cart.lines.filter((l) => !l.comp).map((l) => ({ lineId: l.id, amount: Math.round((lineUnit(l) * l.qty * pct) / 100) })))
}

/** The promo that takes the most off. A code promo only counts when its code was typed. */
export function bestPromo(promos: Promo[], cart: Cart, now: Date) {
  const typed = (cart.promoCode ?? '').trim().toUpperCase()
  let best: { promo: Promo; r: Reduction } | null = null
  for (const p of promos) {
    if (!p.active || (p.code && p.code !== typed)) continue
    const r = promoReduction(p, cart, now)
    if (r && (!best || r.total > best.r.total)) best = { promo: p, r }
  }
  return best
}
