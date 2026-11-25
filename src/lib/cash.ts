/** Over/short against the tolerance setting. Within tolerance (inclusive) needs no note; past it, a note is required. */
export function overShortStatus(counted: number, expected: number, tolerance: number) {
  const diff = counted - expected
  return { diff, within: Math.abs(diff) <= tolerance }
}

export type CashKind = 'drop' | 'paid-out' | 'paid-in' | 'no-sale'
// Every cash movement needs a reason and a supervisor PIN: money (or a drawer open) with no sale behind it (rule 2).
export const CASH_KINDS: { id: CashKind; label: string; sign: -1 | 0 | 1 }[] = [
  { id: 'drop', label: 'Cash drop to the safe', sign: -1 },
  { id: 'paid-out', label: 'Paid-out (expense)', sign: -1 },
  { id: 'paid-in', label: 'Paid-in (cash added)', sign: 1 },
  { id: 'no-sale', label: 'No-sale drawer open', sign: 0 },
]
/** How a movement changes the cash that should be in the drawer. */
export const cashEffect = (kind: CashKind, amount: number) => (CASH_KINDS.find((k) => k.id === kind)?.sign ?? 0) * amount
