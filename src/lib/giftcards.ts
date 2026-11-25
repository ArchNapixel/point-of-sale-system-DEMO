/** A card number people can read out over the phone: GC-4829-1730. The database also checks it is unique. */
export function newCardNumber() {
  const n = new Uint32Array(2)
  crypto.getRandomValues(n)
  const d = (x: number) => String(x % 10000).padStart(4, '0')
  return `GC-${d(n[0])}-${d(n[1])}`
}

export const normCard = (s: string) => s.trim().toUpperCase()

/** Remaining balance from the card's movements (issue +, redeem -, refund +, reissue -). */
export const cardBalance = (tx: { amount: number }[]) => tx.reduce((s, t) => s + t.amount, 0)
