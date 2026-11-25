import type { CartLine } from './cart'

/** Drinks in an order: every line counts, so 30 coffees for a 9 AM meeting is a bulk order. */
export const drinkCount = (lines: Pick<CartLine, 'qty'>[]) => lines.reduce((s, l) => s + l.qty, 0)

/** When the bar must start so the order is ready on time: pickup time minus drinks × minutes each. */
export const startBy = (pickupAt: string, drinks: number, minutesPerItem: number) => new Date(Date.parse(pickupAt) - drinks * minutesPerItem * 60_000)

type P = { id: string; status: string; pickupAt: string; lines: Pick<CartLine, 'qty'>[] }

/** Booked orders whose prep reminder is due: pickup time minus the lead time (or the work needed, if that is longer) has come. */
export function dueSoon<T extends P>(orders: T[], now: Date, leadMin: number, minutesPerItem: number) {
  return orders.filter((o) => o.status === 'booked' && Math.min(Date.parse(o.pickupAt) - leadMin * 60_000, startBy(o.pickupAt, drinkCount(o.lines), minutesPerItem).getTime()) <= now.getTime())
}

/** Open pre-orders in pickup order, each marked bulk or not, with when to start and the drinks due in the same half hour. */
export function timeline<T extends P>(orders: T[], bulkFrom: number, minutesPerItem: number) {
  const open = orders.filter((o) => o.status === 'booked' || o.status === 'preparing').sort((a, b) => a.pickupAt.localeCompare(b.pickupAt))
  const slot = (iso: string) => Math.floor(Date.parse(iso) / 1_800_000)
  return open.map((o) => {
    const drinks = drinkCount(o.lines)
    return { order: o, drinks, bulk: drinks >= bulkFrom, startBy: startBy(o.pickupAt, drinks, minutesPerItem), sameSlot: open.filter((x) => slot(x.pickupAt) === slot(o.pickupAt)).reduce((s, x) => s + drinkCount(x.lines), 0) }
  })
}
