// Loyalty: a stamp card (buy 9, the 10th is free) or points per peso. Points are money we owe, so the rules are settings, applied one way everywhere.
export type Mode = 'off' | 'stamps' | 'points'
export type Programme = {
  mode: Mode
  rewardAt: number // stamps or points that buy one free drink
  pesosPerPoint: number // points mode: one point per this many pesos actually paid
  expiryDays: number // 0 = never
  warnDays: number // show "expires soon" this long before
}

/**
 * What an order earns. Points: on the amount actually paid (after discounts and promos, never the delivery fee), rounded down.
 * Stamps: one per drink that was paid for (free and reward drinks do not earn).
 */
export function earnFor(p: Programme, lines: { qty: number; free: boolean }[], paidTotal: number): number {
  if (p.mode === 'stamps') return lines.reduce((s, l) => s + (l.free ? 0 : l.qty), 0)
  if (p.mode === 'points') return p.pesosPerPoint > 0 ? Math.floor(paidTotal / (p.pesosPerPoint * 100)) : 0
  return 0
}

type Entry = { amount: number; at: string }
const DAY = 86_400_000

/**
 * The balance from the ledger, oldest first. Gains become lots; anything taken off (a reward, a refund reversal, a correction) uses
 * the oldest lots first. Lots older than the expiry are gone. "Expiring soon" lists what will go within the warning window.
 */
export function balance(entries: Entry[], now: Date, expiryDays: number, warnDays: number) {
  const lots: { amount: number; at: number }[] = []
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.amount > 0) lots.push({ amount: e.amount, at: Date.parse(e.at) })
    else {
      let take = -e.amount
      for (const l of lots) {
        if (take <= 0) break
        const used = Math.min(l.amount, take)
        l.amount -= used
        take -= used
      }
    }
  }
  const live = lots.filter((l) => l.amount > 0 && (expiryDays === 0 || l.at + expiryDays * DAY > now.getTime()))
  const soon = expiryDays === 0 ? [] : live.filter((l) => l.at + expiryDays * DAY <= now.getTime() + warnDays * DAY).map((l) => ({ amount: l.amount, expiresAt: new Date(l.at + expiryDays * DAY).toISOString() }))
  return { balance: live.reduce((s, l) => s + l.amount, 0), expiringSoon: soon }
}

/** Earned for a refund: the share of what the order earned that matches the share refunded (rounded down, never more than is left). */
export const reversalFor = (earned: number, alreadyReversed: number, refunded: number, orderTotal: number, all: boolean) =>
  Math.max(0, Math.min(earned - alreadyReversed, all ? earned - alreadyReversed : orderTotal > 0 ? Math.round((earned * refunded) / orderTotal) : 0))
