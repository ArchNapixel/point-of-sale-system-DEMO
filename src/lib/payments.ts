export type PayMethod = 'cash' | 'gcash' | 'maya' | 'card'
export const PAY_METHODS: { id: PayMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'gcash', label: 'GCash' },
  { id: 'maya', label: 'Maya' },
  { id: 'card', label: 'Card' },
]

/** What the cashier enters. Cash gives `tendered`; everything else gives `amount`. */
export type PayLine = { method: PayMethod; amount?: number; tendered?: number; reference?: string; approvalCode?: string; last4?: string }
export type AppliedLine = PayLine & { amount: number; tendered: number; change: number; status: 'verified' | 'pending' }

export const normRef = (s: string | undefined) => (s ?? '').trim().toUpperCase()

/**
 * Applies payment lines to a total, in order. Cash may be tendered above the balance (change is given back);
 * other methods must be within the balance, because an overpayment is a refund, not a payment.
 * E-wallet lines start "pending" until a supervisor sees the money in the merchant app. Throws on a bad line.
 * Returns what is still owed: the order is paid only when remaining is 0.
 */
export function applyLines(total: number, lines: PayLine[]) {
  let remaining = total
  const refs = new Set<string>()
  const applied: AppliedLine[] = lines.map((l) => {
    if (remaining <= 0) throw new Error('The total is already covered')
    if (l.method === 'cash') {
      if (!Number.isInteger(l.tendered) || l.tendered! <= 0) throw new Error('Enter the cash handed over')
      const amount = Math.min(l.tendered!, remaining)
      remaining -= amount
      return { ...l, amount, tendered: l.tendered!, change: l.tendered! - amount, status: 'verified' }
    }
    if (!Number.isInteger(l.amount) || l.amount! <= 0) throw new Error('Enter the amount paid')
    if (l.amount! > remaining) throw new Error('That is more than the balance. An overpayment is refunded, not recorded here.')
    if (l.method === 'card') {
      if (!normRef(l.approvalCode)) throw new Error('Enter the card approval code')
      if (!/^\d{4}$/.test((l.last4 ?? '').trim())) throw new Error('Enter the last 4 digits of the card')
    } else {
      const ref = normRef(l.reference)
      if (!ref) throw new Error('Enter the reference number')
      if (refs.has(ref)) throw new Error('That reference number is already on this order')
      refs.add(ref)
    }
    remaining -= l.amount!
    return { ...l, tendered: l.amount!, change: 0, status: l.method === 'card' ? 'verified' : 'pending' } as AppliedLine
  })
  return { applied, remaining, change: applied.reduce((s, a) => s + a.change, 0) }
}
