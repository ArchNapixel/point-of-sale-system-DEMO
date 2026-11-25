// Stock is a ledger of movements. The level is their sum (per ingredient, per branch); nobody types a level over it (rule 3).
export type StockKind = 'sale' | 'void' | 'receive' | 'waste' | 'transfer-out' | 'transfer-in' | 'production' | 'count'

// Fixed waste reasons. "Calibration" (dialing in the grinder) is its own reason so it does not look like theft.
// Staff meals and samples are deducted here too, so the variance stays honest.
export const WASTE_REASONS = [
  { id: 'spoiled', label: 'Spoiled or expired' },
  { id: 'spilled', label: 'Spilled or dropped' },
  { id: 'calibration', label: 'Grinder calibration' },
  { id: 'staff-meal', label: 'Staff meal' },
  { id: 'sampling', label: 'Tasting or sample' },
  { id: 'end-of-day', label: 'Left over at close' },
  { id: 'remake', label: 'Remade drink' },
  { id: 'other', label: 'Other (note required)' },
] as const

export function checkWasteReason(code: string | undefined, note?: string) {
  if (!WASTE_REASONS.some((r) => r.id === code)) throw new Error('Pick a reason')
  if (code === 'other' && !note?.trim()) throw new Error('"Other" needs a note saying what happened')
}

/** Adds up movements into levels. Negative is allowed: a wrong count must never stop a sale. */
export function levels(moves: { ingredientId: string; branchId: string; qty: number }[], branchId?: string) {
  const out = new Map<string, number>()
  for (const m of moves) if (!branchId || m.branchId === branchId) out.set(m.ingredientId, Math.round(((out.get(m.ingredientId) ?? 0) + m.qty) * 1000) / 1000)
  return out
}
