import { db } from './db'

/**
 * Next order number for a business day: 1, 2, 3… Customers and the bar call orders by this number.
 * Used when the order is paid (1F). Gaps are fine; reuse never happens.
 * ponytail: one counter per business day in this browser's database. Two tablets selling offline at the
 * same time can hand out the same number; fix with a per-terminal prefix when sync lands (4D).
 */
export async function nextOrderNumber(businessDayId: string): Promise<number> {
  return db.transaction('rw', db.counters, async () => {
    const id = `order:${businessDayId}`
    const n = ((await db.counters.get(id))?.last ?? 0) + 1
    await db.counters.put({ id, last: n })
    return n
  })
}
