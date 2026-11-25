import { costOf } from './purchasing'

/** What the ingredients of one drink cost, in whole centavos. An ingredient with no receiving yet has no cost: it is listed, not guessed. */
export function recipeCost(uses: Map<string, number>, avgMilli: Map<string, number | undefined>) {
  let cost = 0
  const unknown: string[] = []
  for (const [id, qty] of uses) {
    const a = avgMilli.get(id)
    if (a === undefined) unknown.push(id)
    else cost += costOf(qty, a)
  }
  return { cost, unknown }
}

/**
 * Margin on a menu price. Prices include VAT at a VAT café, and the VAT is not the café's money, so the margin is worked out on the
 * price without VAT. Returns percent to one decimal.
 */
export function margin(price: number, cost: number, vatRegistered: boolean) {
  const net = vatRegistered ? Math.round(price / 1.12) : price
  return { net, profit: net - cost, pct: net > 0 ? Math.round(((net - cost) / net) * 1000) / 10 : 0 }
}

/** Cup count: fewer cups on the shelf than the sales explain means drinks went out without being rung up. */
export function cupGap(expected: number, counted: number, avgDrinkPrice: number) {
  const missing = Math.max(0, Math.round((expected - counted) * 1000) / 1000)
  return { missing, estimatedLost: Math.round(missing * avgDrinkPrice) }
}
