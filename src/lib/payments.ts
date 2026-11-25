// transfer = bank transfer (a deposit or a pre-order balance). deposit = a customer's earlier deposit applied to the bill.
// platform = a delivery app owes us this money (a receivable, paid out weekly minus commission).
export type PayMethod = 'cash' | 'gcash' | 'maya' | 'card' | 'transfer' | 'deposit' | 'platform'
export const PAY_METHODS: { id: PayMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'gcash', label: 'GCash' },
  { id: 'maya', label: 'Maya' },
  { id: 'card', label: 'Card' },
  { id: 'transfer', label: 'Bank transfer' },
  { id: 'deposit', label: 'Deposit' },
  { id: 'platform', label: 'Delivery app' },
]
/** What a cashier can pick at the till. Deposit and Delivery app are applied by the pre-order and delivery flows, not typed in. */
export const TENDER_METHODS = PAY_METHODS.filter((m) => m.id !== 'deposit' && m.id !== 'platform')

/** What the cashier enters. Cash gives `tendered`; everything else gives `amount`. */
export type PayLine = { method: PayMethod; amount?: number; tendered?: number; reference?: string; approvalCode?: string; last4?: string }
export type AppliedLine = PayLine & { amount: number; tendered: number; change: number; status: 'verified' | 'pending' | 'receivable' }

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
    if (l.method === 'deposit') {
      if (!normRef(l.reference)) throw new Error('A deposit payment needs the deposit it comes from')
    } else if (l.method === 'platform') {
      // nothing more to enter: the delivery app pays us later
    } else if (l.method === 'card') {
      if (!normRef(l.approvalCode)) throw new Error('Enter the card approval code')
      if (!/^\d{4}$/.test((l.last4 ?? '').trim())) throw new Error('Enter the last 4 digits of the card')
    } else {
      const ref = normRef(l.reference)
      if (!ref) throw new Error('Enter the reference number')
      if (refs.has(ref)) throw new Error('That reference number is already on this order')
      refs.add(ref)
    }
    remaining -= l.amount!
    return { ...l, tendered: l.amount!, change: 0, status: l.method === 'card' || l.method === 'deposit' ? 'verified' : l.method === 'platform' ? 'receivable' : 'pending' } as AppliedLine
  })
  return { applied, remaining, change: applied.reduce((s, a) => s + a.change, 0) }
}
