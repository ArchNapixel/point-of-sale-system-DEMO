import { db, type Account, type AccountTx } from './db'
import { newId } from '../lib/id'
import { normRef, type PayMethod } from '../lib/payments'
import { audit } from './audit'
import { businessDate } from './businessDate'
import { getSellContext } from './shifts'
import { getSetting } from './settings'

const sum = (tx: { amount: number }[]) => tx.reduce((s, t) => s + t.amount, 0)

/** What the account owes us now (negative = we owe them credit). */
export const accountBalance = async (accountId: string) => sum(await db.accountTx.where('accountId').equals(accountId).toArray())

/** A company that orders on credit and pays monthly. */
export async function createCorporateAccount(name: string, creditLimit: number, userId: string, note?: string): Promise<Account> {
  const n = name.trim()
  if (!n) throw new Error('Account name is required')
  if (!Number.isInteger(creditLimit) || creditLimit < 0) throw new Error('Enter the credit limit in pesos')
  if ((await db.accounts.toArray()).some((a) => a.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  const a: Account = { id: newId(), kind: 'corporate', name: n, creditLimit, ...(note?.trim() && { note: note.trim() }), active: true }
  await db.accounts.add(a)
  await audit({ userId, action: 'account.create', ref: a.id, detail: { name: n, creditLimit, kind: a.kind } })
  return a
}

/** A staff member's meal account, deducted from pay. The limit per person is a setting unless given. */
export async function createStaffAccount(staffId: string, userId: string, creditLimit?: number): Promise<Account> {
  const staff = await db.users.get(staffId)
  if (!staff?.active) throw new Error('Pick an active staff member')
  if ((await db.accounts.toArray()).some((a) => a.userId === staffId && a.active)) throw new Error(`${staff.name} already has a staff account`)
  const limit = creditLimit ?? (await getSetting('staffChargeLimitCentavos'))
  const a: Account = { id: newId(), kind: 'staff', name: staff.name, creditLimit: limit, userId: staffId, active: true }
  await db.accounts.add(a)
  await audit({ userId, action: 'account.create', ref: a.id, detail: { name: a.name, creditLimit: limit, kind: 'staff' } })
  return a
}

export async function setCreditLimit(id: string, creditLimit: number, userId: string) {
  if (!Number.isInteger(creditLimit) || creditLimit < 0) throw new Error('Enter the credit limit in pesos')
  const a = await db.accounts.get(id)
  if (!a) throw new Error('Account not found')
  await db.accounts.update(id, { creditLimit })
  await audit({ userId, action: 'account.limit', ref: id, detail: { from: a.creditLimit, to: creditLimit } })
}

export async function setAccountActive(id: string, active: boolean, userId: string) {
  await db.accounts.update(id, { active })
  await audit({ userId, action: active ? 'account.restore' : 'account.archive', ref: id })
}

/** How far over the limit a new charge would put the account (0 = within it). */
export async function overLimitBy(accountId: string, amount: number) {
  const a = await db.accounts.get(accountId)
  if (!a?.active) throw new Error('That charge account is not active')
  return Math.max(0, (await accountBalance(accountId)) + amount - a.creditLimit)
}

/** Records a sale on the account. Runs inside the sale's transaction. */
export async function chargeToAccount(accountId: string, amount: number, orderId: string, userId: string, businessDate: string, approvedBy?: string) {
  await db.accountTx.add({ id: newId(), accountId, kind: 'charge', amount, orderId, at: new Date().toISOString(), by: userId, businessDate, ...(approvedBy && { approvedBy }) })
}

/** A voided or refunded sale that was charged gives the account its credit back. Runs inside the refund's transaction. */
export async function creditAccount(accountId: string, amount: number, orderId: string, userId: string, businessDate: string) {
  await db.accountTx.add({ id: newId(), accountId, kind: 'refund', amount: -amount, orderId, at: new Date().toISOString(), by: userId, businessDate })
}

/**
 * The account pays (cash at the counter, or a transfer). Cash goes into the open shift's drawer, so it needs a shift;
 * other methods need their reference. Paying more than is owed is refused: that would be a credit, not a payment.
 */
export async function receiveAccountPayment(i: { accountId: string; amount: number; method: PayMethod; reference?: string; terminalId: string; userId: string }): Promise<AccountTx> {
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new Error('Enter the amount received in pesos')
  if (!['cash', 'gcash', 'maya', 'card', 'transfer'].includes(i.method)) throw new Error('Pick how it was paid')
  if (i.method !== 'cash' && !normRef(i.reference)) throw new Error('Enter the reference number of the payment')
  const a = await db.accounts.get(i.accountId)
  if (!a) throw new Error('Account not found')
  const owed = await accountBalance(a.id)
  if (i.amount > owed) throw new Error(`${a.name} owes only ₱${(Math.max(0, owed) / 100).toFixed(2)}`)
  const ctx = await getSellContext(i.terminalId)
  if (i.method === 'cash' && !ctx) throw new Error('Cash goes in a drawer: open a business day and a shift on this terminal first')
  if (ctx && i.method === 'cash' && ctx.shift.cashierId !== i.userId) throw new Error('This drawer belongs to another cashier')
  const now = new Date()
  const tx: AccountTx = {
    id: newId(), accountId: a.id, kind: 'payment', amount: -i.amount, at: now.toISOString(), by: i.userId, method: i.method,
    businessDate: ctx?.day.date ?? businessDate(now, await getSetting('dayCutoffHour')), ...(i.reference && { reference: normRef(i.reference) }), ...(ctx && { shiftId: ctx.shift.id }),
  }
  await db.accountTx.add(tx)
  await audit({ userId: i.userId, action: 'account.payment', ref: a.id, detail: { amount: i.amount, method: i.method } })
  return tx
}

/**
 * The monthly statement: what was owed at the start, each charge (with its invoice number), each payment, and what is owed at the end.
 * For a staff account the closing balance is what comes off their pay.
 */
export async function statement(accountId: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month looks like 2026-11')
  const a = await db.accounts.get(accountId)
  if (!a) throw new Error('Account not found')
  const all = await db.accountTx.where('accountId').equals(accountId).toArray()
  const before = all.filter((t) => t.businessDate < `${month}-01`)
  const inMonth = all.filter((t) => t.businessDate.startsWith(month)).sort((x, y) => x.at.localeCompare(y.at))
  const orders = new Map((await db.orders.where('id').anyOf(inMonth.flatMap((t) => (t.orderId ? [t.orderId] : []))).toArray()).map((o) => [o.id, o.invoiceNo]))
  const opening = sum(before)
  return {
    account: a, opening, closing: opening + sum(inMonth),
    charged: sum(inMonth.filter((t) => t.kind === 'charge')), paid: -sum(inMonth.filter((t) => t.kind === 'payment')), refunded: -sum(inMonth.filter((t) => t.kind === 'refund')),
    lines: inMonth.map((t) => ({ ...t, invoiceNo: t.orderId ? orders.get(t.orderId) : undefined })),
  }
}
