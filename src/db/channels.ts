import { db, type Channel, type ChannelPayout } from './db'
import { newId } from '../lib/id'
import { pct } from '../lib/money'
import { audit } from './audit'

const checkPct = (n: number) => {
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Commission is a percent from 0 to 100')
}

/** A delivery app. The commission % is a setting per platform, never hard-coded. */
export async function createChannel(name: string, commissionPct: number, userId: string): Promise<Channel> {
  const n = name.trim()
  if (!n) throw new Error('Channel name is required')
  checkPct(commissionPct)
  if ((await db.channels.toArray()).some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  const c: Channel = { id: newId(), name: n, commissionPct, active: true }
  await db.channels.add(c)
  await audit({ userId, action: 'channel.create', ref: c.id, detail: { name: n, commissionPct } })
  return c
}

/** Changing the commission affects new orders only: each order keeps the % it was sold under. */
export async function setCommission(id: string, commissionPct: number, userId: string) {
  checkPct(commissionPct)
  const c = await db.channels.get(id)
  if (!c) throw new Error('Channel not found')
  await db.channels.update(id, { commissionPct })
  await audit({ userId, action: 'channel.commission', ref: id, detail: { from: c.commissionPct, to: commissionPct } })
}

export async function setChannelActive(id: string, active: boolean, userId: string) {
  await db.channels.update(id, { active })
  await audit({ userId, action: active ? 'channel.restore' : 'channel.archive', ref: id })
}

/** A price for one size on one app (null = use the counter price). Modifier prices stay as they are. */
export async function setChannelPrice(channelId: string, variantId: string, price: number | null, userId: string) {
  if (!(await db.channels.get(channelId))) throw new Error('Channel not found')
  if (!(await db.variants.get(variantId))) throw new Error('Size not found')
  if (price === null) await db.channelPrices.delete([channelId, variantId])
  else {
    if (!Number.isInteger(price) || price <= 0) throw new Error('Enter the price in pesos')
    await db.channelPrices.put({ channelId, variantId, price })
  }
  await audit({ userId, action: 'channel.price', ref: channelId, detail: { variantId, price } })
}

export async function channelPriceMap(channelId: string) {
  return new Map((await db.channelPrices.where('channelId').equals(channelId).toArray()).map((p) => [p.variantId, p.price]))
}

/** What the app owes for an order: the sale minus the commission it was sold under. */
export const netOfCommission = (total: number, commissionPct: number) => total - pct(total, commissionPct)

/** Orders sold through an app whose money has not arrived yet. */
export async function receivables(channelId: string) {
  const orders = (await db.orders.filter((o) => o.channelId === channelId && o.status === 'paid').toArray())
  const pays = await db.payments.where('orderId').anyOf(orders.map((o) => o.id)).toArray()
  const open = new Set(pays.filter((p) => p.method === 'platform' && p.status === 'receivable').map((p) => p.orderId))
  return orders.filter((o) => open.has(o.id)).sort((a, b) => a.paidAt.localeCompare(b.paidAt))
}

/**
 * The platform paid out (weekly, minus commission). Records what was received against what the orders should bring in; the gap is shown,
 * never hidden: it is either the platform's other charges or an order it did not pay for.
 */
export async function settlePayout(i: { channelId: string; orderIds: string[]; received: number; reference?: string; userId: string }): Promise<ChannelPayout> {
  if (!Number.isInteger(i.received) || i.received < 0) throw new Error('Enter the amount received in pesos')
  if (i.orderIds.length === 0) throw new Error('Pick the orders this payout covers')
  const open = new Map((await receivables(i.channelId)).map((o) => [o.id, o]))
  const picked = i.orderIds.map((id) => open.get(id))
  if (picked.some((o) => !o)) throw new Error('One of those orders is not waiting for the platform')
  const orders = picked as NonNullable<(typeof picked)[number]>[]
  const gross = orders.reduce((s, o) => s + o.total, 0)
  const expected = orders.reduce((s, o) => s + netOfCommission(o.total, o.commissionPct ?? 0), 0)
  const payout: ChannelPayout = { id: newId(), channelId: i.channelId, orderIds: i.orderIds, gross, expected, received: i.received, ...(i.reference?.trim() && { reference: i.reference.trim() }), at: new Date().toISOString(), by: i.userId }
  await db.transaction('rw', [db.channelPayouts, db.payments, db.outbox], async () => {
    await db.channelPayouts.add(payout)
    await db.payments.where('orderId').anyOf(i.orderIds).and((p) => p.method === 'platform').modify({ status: 'verified', verifiedBy: i.userId, verifiedAt: payout.at })
    await db.outbox.add({ id: newId(), table: 'channelPayouts', recordId: payout.id, at: payout.at, synced: 0 })
  })
  await audit({ userId: i.userId, action: 'channel.payout', ref: payout.id, detail: { channelId: i.channelId, gross, expected, received: i.received, gap: i.received - expected } })
  return payout
}

/** The daily check: the app's own order count against what was keyed into the POS. A gap means an order was never keyed in. */
export async function dailyCheck(i: { channelId: string; date: string; platformCount: number; userId: string }) {
  if (!Number.isInteger(i.platformCount) || i.platformCount < 0) throw new Error('Enter how many orders the app shows')
  const posCount = (await db.orders.filter((o) => o.channelId === i.channelId && o.businessDate === i.date && o.status === 'paid').toArray()).length
  await db.channelChecks.put({ channelId: i.channelId, date: i.date, platformCount: i.platformCount, posCount, by: i.userId, at: new Date().toISOString() })
  const missing = i.platformCount - posCount
  if (missing !== 0) await audit({ userId: i.userId, action: 'channel.countGap', ref: i.channelId, detail: { date: i.date, platformCount: i.platformCount, posCount, missing } })
  return { posCount, missing }
}
