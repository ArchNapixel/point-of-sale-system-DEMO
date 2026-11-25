import type { CartLine } from './cart'
import { lineTotal } from './cart'

// Splitting a tab into bills, one per payer. Amounts are integer centavos and always add up to what is due, to the centavo.
export type Due = { lineId: string; name: string; variantLabel: string; total: number; due: number } // total = full line price, due = what is still unpaid
export type BillLine = { lineId: string; name: string; variantLabel: string; amount: number; whole: boolean; share?: { n: number } } // share n = 1 of n (a cake in thirds)
export type BillPart = { id: string; label: string; lines: BillLine[]; amount: number; paidOrderId?: string }

/** Largest-remainder split: pieces differ by at most 1 centavo and add up exactly. Earlier payers take the extra centavos. */
export function allocate(amount: number, n: number): number[] {
  if (!Number.isInteger(amount) || amount < 0) throw new Error('Amount must be whole centavos')
  if (!Number.isInteger(n) || n < 1) throw new Error('Split between at least 1 payer')
  const base = Math.floor(amount / n)
  const extra = amount - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

/** What is still unpaid on each line of a tab, given what earlier bills already settled. Lines fully paid are left out. */
export function dues(lines: CartLine[], settled: Record<string, number>): Due[] {
  return lines.flatMap((l) => {
    const total = lineTotal(l)
    const due = total - (settled[l.id] ?? 0)
    return due > 0 || (total === 0 && !(l.id in settled)) ? [{ lineId: l.id, name: l.name, variantLabel: l.variantLabel, total, due: Math.max(0, due) }] : []
  })
}

const newPart = (id: string, label: string, lines: BillLine[]): BillPart => ({ id, label, lines, amount: lines.reduce((s, l) => s + l.amount, 0) })

/**
 * By item, by seat or by shared fractions: `assign` says which payers (0-based) take each line. A line given to one payer goes whole;
 * given to several, it is split equally between them (a whole cake in thirds). Every line that is still due must go to someone.
 */
export function partsByLines(d: Due[], assign: Record<string, number[]>, labels: string[], ids: () => string): BillPart[] {
  const lines: BillLine[][] = labels.map(() => [])
  for (const x of d) {
    const who = assign[x.lineId] ?? []
    if (who.length === 0) throw new Error(`Give "${x.name}" to someone`)
    if (who.some((p) => !Number.isInteger(p) || p < 0 || p >= labels.length)) throw new Error('That payer does not exist')
    if (new Set(who).size !== who.length) throw new Error(`"${x.name}" lists the same payer twice`)
    if (x.total === 0 && who.length > 1) throw new Error(`"${x.name}" is a comp and cannot be split`)
    if (who.length === 1) {
      lines[who[0]].push({ lineId: x.lineId, name: x.name, variantLabel: x.variantLabel, amount: x.due, whole: x.due === x.total })
    } else {
      allocate(x.due, who.length).forEach((amt, i) => lines[who[i]].push({ lineId: x.lineId, name: x.name, variantLabel: x.variantLabel, amount: amt, whole: false, share: { n: who.length } }))
    }
  }
  const parts = labels.map((label, i) => newPart(ids(), label, lines[i]))
  const empty = parts.find((p) => p.lines.length === 0)
  if (empty) throw new Error(`${empty.label} has nothing to pay. Remove that payer or give them something.`)
  return parts
}

/** Everyone pays the same: the total due split evenly (any odd centavos go to the first payers). */
export function partsEven(d: Due[], n: number, ids: () => string): BillPart[] {
  const total = d.reduce((s, x) => s + x.due, 0)
  return allocate(total, n).map((amt, i) => newPart(ids(), `Payer ${i + 1}`, [{ lineId: '', name: `Share of the bill (1/${n})`, variantLabel: '', amount: amt, whole: false }]))
}

/** Each payer says an amount. They must add up to exactly what is due. */
export function partsCustom(d: Due[], amounts: number[], ids: () => string): BillPart[] {
  const total = d.reduce((s, x) => s + x.due, 0)
  if (amounts.some((a) => !Number.isInteger(a) || a <= 0)) throw new Error('Every amount must be more than 0')
  const sum = amounts.reduce((s, a) => s + a, 0)
  if (sum !== total) throw new Error(`The amounts add up to ${sum / 100} but the bill is ${total / 100}`)
  return amounts.map((amt, i) => newPart(ids(), `Payer ${i + 1}`, [{ lineId: '', name: 'Part of the bill', variantLabel: '', amount: amt, whole: false }]))
}

/**
 * The cart a part is paid from. A whole, untouched line keeps its own details (add-ons, notes, price). A fraction or a balance becomes one
 * line at its share of the price. Stock was taken when the drinks were sent, so these lines never deduct again.
 */
export function partToCartLines(part: BillPart, tabLines: CartLine[]): CartLine[] {
  return part.lines.map((bl, i) => {
    const orig = tabLines.find((l) => l.id === bl.lineId)
    if (orig && bl.whole) return orig
    return {
      id: `${bl.lineId || 'part'}:${part.id}:${i}`, itemId: orig?.itemId ?? '', variantId: orig?.variantId ?? '',
      name: bl.share ? `${bl.name} (1/${bl.share.n})` : bl.name, variantLabel: bl.variantLabel, basePrice: bl.amount, mods: [], notes: [], allergy: '', qty: 1,
    }
  })
}
