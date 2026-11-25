import { db, type Deposit, type PreOrder } from './db'
import { newId } from '../lib/id'
import { lineTotal, type CartLine } from '../lib/cart'
import { checkReason } from '../lib/reasons'
import { drinkCount } from '../lib/preorders'
import { normRef, type PayMethod } from '../lib/payments'
import { audit } from './audit'
import { consumeApproval } from './approvals'
import { createQueueItems } from './queue'
import { alertAfterSale, deductSale, syncModifierAvailability } from './stock'
import { getSellContext } from './shifts'
import { businessDate } from './businessDate'
import { getSetting } from './settings'

const DEPOSIT_METHODS: PayMethod[] = ['cash', 'gcash', 'maya', 'card', 'transfer']
const linesTotal = (lines: CartLine[]) => lines.reduce((s, l) => s + lineTotal(l), 0)

/**
 * Books a pre-order: a scheduled pickup or delivery, with an optional deposit taken now. The deposit is money we owe back until the order
 * is paid, so it is not a sale. The cancel policy (refund or keep) is saved on the order when it is taken.
 * Cash deposits go in the drawer of the open shift, so they must be taken on a terminal with a shift.
 */
export async function createPreOrder(i: {
  terminalId: string; userId: string; customerName: string; phone?: string; kind: 'pickup' | 'delivery'; pickupAt: string; lines: CartLine[]
  deliveryFee?: number; note?: string; depositPolicy: 'refund' | 'keep'; deposit?: { amount: number; method: PayMethod; reference?: string }; idempotencyKey: string
}): Promise<{ preOrder: PreOrder; deposit?: Deposit }> {
  const terminal = await db.terminals.get(i.terminalId)
  if (!terminal?.active) throw new Error('Book on a store terminal')
  if (!i.customerName.trim()) throw new Error("Enter the customer's name")
  if (i.lines.length === 0) throw new Error('The order is empty')
  const at = new Date(i.pickupAt)
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000) throw new Error('Pick a pickup time in the future')
  if (i.deliveryFee !== undefined && (!Number.isInteger(i.deliveryFee) || i.deliveryFee < 0)) throw new Error('The delivery fee must be whole centavos')
  const prior = await db.preOrders.filter((p) => p.id === i.idempotencyKey).first()
  if (prior) return { preOrder: prior, deposit: await db.deposits.where('preOrderId').equals(prior.id).first() }
  for (const l of i.lines) if (l.comp) checkReason(l.comp.code, l.comp.note)
  const total = linesTotal(i.lines) + (i.deliveryFee ?? 0)
  const d = i.deposit
  if (d) {
    if (!DEPOSIT_METHODS.includes(d.method)) throw new Error('Pick how the deposit was paid')
    if (!Number.isInteger(d.amount) || d.amount <= 0) throw new Error('Enter the deposit amount')
    if (d.amount > total) throw new Error('The deposit is more than the order')
    if (d.method !== 'cash' && !normRef(d.reference)) throw new Error('Enter the reference number of the deposit')
    if (d.method !== 'cash' && d.reference && (await db.deposits.filter((x) => x.reference === normRef(d.reference)).count()) > 0) throw new Error('That reference number was already used on another deposit')
  }
  const ctx = d ? await getSellContext(i.terminalId) : null
  if (d && !ctx) throw new Error('Taking a deposit needs an open business day and an open shift on this terminal')
  if (d && ctx!.shift.cashierId !== i.userId) throw new Error('This drawer belongs to another cashier')

  const now = new Date()
  const pre: PreOrder = {
    id: i.idempotencyKey, branchId: terminal.branchId, customerName: i.customerName.trim(), ...(i.phone?.trim() && { phone: i.phone.trim() }), kind: i.kind, pickupAt: at.toISOString(),
    lines: i.lines, ...(i.deliveryFee ? { deliveryFee: i.deliveryFee } : {}), ...(i.note?.trim() && { note: i.note.trim() }), depositPolicy: i.depositPolicy, status: 'booked', createdAt: now.toISOString(), createdBy: i.userId,
  }
  const dep: Deposit | undefined = d && ctx ? {
    id: newId(), preOrderId: pre.id, amount: d.amount, method: d.method, ...(d.reference && { reference: normRef(d.reference) }), shiftId: ctx.shift.id,
    businessDate: ctx.day.date || businessDate(now, await getSetting('dayCutoffHour')), at: now.toISOString(), by: i.userId, status: 'held',
  } : undefined
  await db.transaction('rw', [db.preOrders, db.deposits, db.outbox], async () => {
    await db.preOrders.add(pre)
    if (dep) await db.deposits.add(dep)
    await db.outbox.bulkAdd([{ id: newId(), table: 'preOrders', recordId: pre.id, at: pre.createdAt, synced: 0 }, ...(dep ? [{ id: newId(), table: 'deposits', recordId: dep.id, at: pre.createdAt, synced: 0 }] : [])])
  })
  await audit({ userId: i.userId, action: 'preorder.create', ref: pre.id, detail: { customer: pre.customerName, pickupAt: pre.pickupAt, drinks: drinkCount(i.lines), total, policy: pre.depositPolicy } })
  if (dep) await audit({ userId: i.userId, action: 'deposit.take', ref: dep.id, detail: { amount: dep.amount, method: dep.method, preOrderId: pre.id } })
  return { preOrder: pre, deposit: dep }
}

/**
 * The bar starts the order (usually after the reminder): tickets go up marked rush, and the ingredients are taken now, like a tab's round.
 * Paying at pickup then changes neither. A pre-order with nobody starting it is simply made when it is paid.
 */
export async function startPrep(preOrderId: string, userId: string) {
  const res = await db.transaction('rw', [db.preOrders, db.queueItems, db.queueEvents, db.items, db.categories, db.stockMoves, db.recipes, db.ingredients, db.settings], async () => {
    const p = await db.preOrders.get(preOrderId)
    if (!p || p.status !== 'booked') throw new Error('This pre-order is not waiting to be made')
    const now = new Date()
    const pseudo = { id: p.id, branchId: p.branchId, orderType: p.kind === 'delivery' ? ('takeout' as const) : ('pickup' as const), lines: p.lines, paidAt: now.toISOString(), number: 0, name: p.customerName, table: '' }
    await createQueueItems(pseudo, userId, { preOrderId: p.id })
    const time = new Date(p.pickupAt).toLocaleTimeString('en-PH', { timeStyle: 'short' })
    await db.queueItems.where('orderId').equals(p.id).modify({ rush: true, rushReason: `Pre-order due ${time}` })
    const sale = await deductSale(pseudo, userId)
    await db.preOrders.update(p.id, { status: 'preparing', prepStartedAt: now.toISOString() })
    return sale
  })
  await audit({ userId, action: 'preorder.startPrep', ref: preOrderId })
  await alertAfterSale(res.crossed, userId)
  await syncModifierAvailability(userId).catch(() => {})
}

/**
 * Cancels a pre-order (the meeting moved). Needs a reason. The deposit is refunded or kept by the policy saved on the order, and either
 * way a supervisor PIN is needed when money is involved. If the bar already started, the drinks are waste (the ingredients are gone).
 */
export async function cancelPreOrder(i: { preOrderId: string; userId: string; terminalId: string; reasonCode: string; reasonNote?: string; approvalId?: string }) {
  checkReason(i.reasonCode, i.reasonNote)
  const out = await db.transaction('rw', [db.preOrders, db.deposits, db.queueItems, db.approvals, db.users, db.settings, db.shifts, db.businessDays, db.terminals, db.heldCarts, db.orders, db.payments, db.refunds, db.cashMovements, db.tabs, db.outbox], async () => {
    const p = await db.preOrders.get(i.preOrderId)
    if (!p || (p.status !== 'booked' && p.status !== 'preparing')) throw new Error('This pre-order cannot be cancelled')
    const dep = (await db.deposits.where('preOrderId').equals(p.id).toArray()).find((x) => x.status === 'held')
    let outcome: 'refunded' | 'kept' | 'none' = 'none'
    if (dep) {
      const ctx = await getSellContext(i.terminalId)
      if (!ctx) throw new Error('Open a business day and a shift on this terminal first: the deposit is settled from its drawer')
      const approvedBy = await consumeApproval(i.userId, 'refund', dep.amount, dep.id, i.approvalId, p.id)
      if (!approvedBy) throw new Error('This needs a supervisor PIN')
      outcome = p.depositPolicy === 'refund' ? 'refunded' : 'kept'
      await db.deposits.update(dep.id, {
        status: outcome === 'refunded' ? 'refunded' : 'forfeited',
        settled: { at: new Date().toISOString(), by: i.userId, shiftId: ctx.shift.id, approvedBy, ...(outcome === 'refunded' && { method: dep.method }) },
      })
    }
    const wasMade = p.status === 'preparing'
    if (wasMade) await db.queueItems.where('orderId').equals(p.id).modify({ status: 'void', wasted: true })
    await db.preOrders.update(p.id, { status: 'cancelled', cancelled: { at: new Date().toISOString(), by: i.userId, reason: i.reasonCode, ...(i.reasonNote?.trim() && { note: i.reasonNote.trim() }), deposit: outcome, wasMade } })
    return { outcome, wasMade, amount: dep?.amount ?? 0 }
  })
  await audit({ userId: i.userId, action: 'preorder.cancel', ref: i.preOrderId, detail: { reason: i.reasonCode, deposit: out.outcome, amount: out.amount, wasMade: out.wasMade } })
  return out
}

export const heldDeposit = async (preOrderId: string) => (await db.deposits.where('preOrderId').equals(preOrderId).toArray()).find((d) => d.status === 'held')
