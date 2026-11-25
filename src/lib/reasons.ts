// Fixed reason codes for anything that undoes or gives away a sale. "Other" must say what happened.
export const REASONS = [
  { id: 'wrong-order', label: 'Wrong order' },
  { id: 'changed-mind', label: 'Customer changed mind' },
  { id: 'quality-complaint', label: 'Quality complaint' },
  { id: 'long-wait', label: 'Long wait' },
  { id: 'foreign-object', label: 'Foreign object' },
  { id: 'duplicate-entry', label: 'Duplicate entry' },
  { id: 'payment-problem', label: 'Payment problem' },
  { id: 'other', label: 'Other (note required)' },
] as const

export function checkReason(code: string | undefined, note?: string) {
  if (!REASONS.some((r) => r.id === code)) throw new Error('Pick a reason')
  if (code === 'other' && !note?.trim()) throw new Error('"Other" needs a note saying what happened')
}
