import { db } from './db'
import { entryHours } from '../lib/timeclock'
import { shareByHours } from '../lib/tips'

/**
 * Tips and service charge collected between two business dates, for sharing among staff. Both are kept apart from sales.
 * Each day's pool is shared by hours worked that day (from the clock-ins); a day with no clock-ins is listed unshared.
 */
export async function tipReport(from: string, to: string) {
  const orders = (await db.orders.where('businessDate').between(from, to, true, true).toArray()).filter((o) => o.status === 'paid' && ((o.tip ?? 0) > 0 || (o.serviceCharge ?? 0) > 0))
  const entries = (await db.timeEntries.where('businessDate').between(from, to, true, true).toArray()).filter((e) => e.outAt)
  const dates = [...new Set(orders.map((o) => o.businessDate))].sort()
  const days = dates.map((date) => {
    const os = orders.filter((o) => o.businessDate === date)
    const tips = os.reduce((s, o) => s + (o.tip ?? 0), 0)
    const service = os.reduce((s, o) => s + (o.serviceCharge ?? 0), 0)
    const hours = new Map<string, number>()
    for (const e of entries.filter((x) => x.businessDate === date)) hours.set(e.userId, (hours.get(e.userId) ?? 0) + entryHours(e))
    return { date, tips, service, pool: tips + service, orders: os.length, shares: shareByHours(tips + service, hours), shared: hours.size > 0 }
  })
  const people = new Map<string, number>()
  for (const d of days) for (const [id, v] of d.shares) people.set(id, (people.get(id) ?? 0) + v)
  const names = new Map((await db.users.toArray()).map((u) => [u.id, u.name]))
  return {
    days,
    tips: days.reduce((s, d) => s + d.tips, 0),
    service: days.reduce((s, d) => s + d.service, 0),
    unshared: days.filter((d) => !d.shared).reduce((s, d) => s + d.pool, 0),
    people: [...people].map(([id, amount]) => ({ userId: id, name: names.get(id) ?? '?', amount })).sort((a, b) => b.amount - a.amount),
  }
}
