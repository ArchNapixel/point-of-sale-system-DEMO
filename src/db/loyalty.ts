import { db, type LoyaltyEntry, type Order } from './db'
import { newId } from '../lib/id'
import { balance, earnFor, reversalFor, type Mode, type Programme } from '../lib/loyalty'
import { audit } from './audit'
import { consumeApproval } from './approvals'
import { businessDate } from './businessDate'
import { getSetting } from './settings'
import { familyIds } from './customers'

export async function getProgramme(): Promise<Programme> {
  const mode = String(await getSetting('loyaltyMode')).toLowerCase()
  return {
    mode: (['stamps', 'points'].includes(mode) ? mode : 'off') as Mode,
    rewardAt: await getSetting('loyaltyRewardAt'),
    pesosPerPoint: await getSetting('loyaltyPesosPerPoint'),
    expiryDays: await getSetting('loyaltyExpiryDays'),
    warnDays: await getSetting('loyaltyWarnDays'),
  }
}

/** Balance of a person (all their merged profiles), with what is about to expire. */
export async function customerBalance(customerId: string, now = new Date()) {
  const p = await getProgramme()
  const ids = await familyIds(customerId)
  const entries = (await db.loyaltyLedger.where('customerId').anyOf(ids).toArray())
  return { ...balance(entries, now, p.expiryDays, p.warnDays), programme: p, entries: entries.sort((a, b) => b.at.localeCompare(a.at)) }
}

async function put(e: Omit<LoyaltyEntry, 'id' | 'at' | 'businessDate'>, at = new Date()) {
  const row: LoyaltyEntry = { ...e, id: newId(), at: at.toISOString(), businessDate: businessDate(at, await getSetting('dayCutoffHour')) }
  await db.loyaltyLedger.add(row)
  return row
}

/**
 * Earns on a paid order: the amount actually paid (points) or the drinks paid for (stamps). One rule, applied everywhere.
 * Runs inside the sale's transaction on loyaltyLedger and settings. Returns what was earned.
 */
export async function earnOrder(order: Pick<Order, 'id' | 'lines' | 'total' | 'paidAt'>, customerId: string, userId: string) {
  const p = await getProgramme()
  const amount = earnFor(p, order.lines.map((l) => ({ qty: l.qty, free: !!l.comp })), order.total)
  if (amount > 0) await put({ customerId, kind: 'earn', amount, orderId: order.id, by: userId }, new Date(order.paidAt))
  return amount
}

/** A free drink: the stamps or points come off the balance in the same save as the ₱0 line. Refused if the customer has not got enough. */
export async function redeemRewards(orderId: string, customerId: string, units: number, userId: string) {
  const p = await getProgramme()
  if (p.mode === 'off') throw new Error('Loyalty is switched off')
  const cost = units * p.rewardAt
  const have = (await customerBalance(customerId)).balance
  if (have < cost) throw new Error(`The customer has ${have} of the ${cost} ${p.mode === 'stamps' ? 'stamps' : 'points'} needed`)
  await put({ customerId, kind: 'redeem', amount: -cost, orderId, by: userId, note: `${units} free drink(s)` })
}

/** A refund takes back the same share of what the sale earned (all of it for a void). Runs inside the refund's transaction. */
export async function reverseEarn(order: Pick<Order, 'id' | 'total' | 'customerId'>, refundedAmount: number, all: boolean, refundId: string, userId: string) {
  if (!order.customerId) return 0
  const entries = (await db.loyaltyLedger.where('orderId').equals(order.id).toArray())
  const earned = entries.filter((e) => e.kind === 'earn').reduce((s, e) => s + e.amount, 0)
  const back = reversalFor(earned, -entries.filter((e) => e.kind === 'reverse').reduce((s, e) => s + e.amount, 0), refundedAmount, order.total, all)
  if (back > 0) await put({ customerId: order.customerId, kind: 'reverse', amount: -back, orderId: order.id, refundId, by: userId })
  return back
}

/**
 * Adds or removes stamps or points by hand. Always needs a reason and a supervisor PIN, and shows up in the loyalty flags,
 * because stamps without a matching sale are the classic way to cheat.
 */
export async function adjustLoyalty(i: { customerId: string; amount: number; reason: string; userId: string; approvalId?: string }) {
  if (!i.reason.trim()) throw new Error('A reason is required')
  if (!Number.isInteger(i.amount) || i.amount === 0) throw new Error('Enter how many to add (or take off with a minus)')
  const c = await db.customers.get(i.customerId)
  if (!c?.active) throw new Error('That profile is not active')
  const id = newId()
  const approvedBy = await db.transaction('rw', [db.approvals, db.users, db.settings], async () => await consumeApproval(i.userId, 'loyalty', Math.abs(i.amount), id, i.approvalId, i.customerId))
  if (!approvedBy) throw new Error('This needs a supervisor PIN')
  const row = await put({ customerId: i.customerId, kind: 'adjust', amount: i.amount, by: i.userId, approvedBy, note: i.reason.trim() })
  await audit({ userId: i.userId, approverId: approvedBy, action: 'loyalty.adjust', ref: i.customerId, detail: { amount: i.amount, reason: i.reason.trim() } })
  return row
}

/** What to look at: stamps added by hand, customers earning from many orders in one day, and a profile named like a member of staff. */
export async function loyaltyFlags() {
  const limit = await getSetting('loyaltyFastEarnPerDay')
  const ledger = await db.loyaltyLedger.toArray()
  const names = new Map((await db.customers.toArray()).map((c) => [c.id, c.name]))
  const staff = new Set((await db.users.filter((u) => u.active).toArray()).map((u) => u.name.trim().toLowerCase()))
  const perDay = new Map<string, number>()
  for (const e of ledger.filter((x) => x.kind === 'earn')) perDay.set(`${e.customerId}|${e.businessDate}`, (perDay.get(`${e.customerId}|${e.businessDate}`) ?? 0) + 1)
  return {
    adjustments: ledger.filter((e) => e.kind === 'adjust').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50).map((e) => ({ ...e, name: names.get(e.customerId) ?? '?' })),
    fast: [...perDay].filter(([, n]) => n > limit).map(([k, n]) => ({ customerId: k.split('|')[0], date: k.split('|')[1], orders: n, name: names.get(k.split('|')[0]) ?? '?' })),
    staffProfiles: [...new Set(ledger.filter((e) => e.kind === 'earn').map((e) => e.customerId))].filter((id) => staff.has((names.get(id) ?? '').trim().toLowerCase())).map((id) => ({ customerId: id, name: names.get(id) ?? '?' })),
  }
}
