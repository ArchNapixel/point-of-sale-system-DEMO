import { db, type DiscountLogEntry, type Order, type Payment } from './db'
import { consumeApproval } from './approvals'
import { createQueueItems } from './queue'
import { formatInvoiceNo } from '../lib/invoice'
import { newId } from '../lib/id'
import { cartCount, type Cart } from '../lib/cart'
import { applyLines, normRef, type PayLine } from '../lib/payments'
import { formatPeso } from '../lib/money'
import { priceCart, validateStatutory } from '../lib/discount'
import { audit } from './audit'
import { getSetting } from './settings'
import { getSellContext } from './shifts'

/**
 * Saves a cart as a paid order once the payment lines add up to the total (split tender, partial lines, cash change).
 * Otherwise nothing is saved and the cart stays unpaid. E-wallet lines are saved "pending" for a supervisor to verify;
 * they never block the sale (rule 1). A GCash/Maya reference number can only be used once, ever.
 * Calling again with the same idempotency key returns the first result (line i uses `${key}:${i}`).
 */
export async function payOrder(
  terminalId: string, userId: string, cart: Cart, lines: PayLine[], idempotencyKey: string, buyer?: { name: string; tin: string }, approvalId?: string,
) {
  const prior = await db.payments.where('idempotencyKey').equals(`${idempotencyKey}:0`).first()
  if (prior) return { order: (await db.orders.get(prior.orderId))!, payments: await db.payments.where('orderId').equals(prior.orderId).toArray() }
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  const vat = await getSetting('vatRegistered')
  const priced = priceCart(cart, vat)
  if (cart.discount) {
    validateStatutory(cart.discount)
    if (!priced.discount) throw new Error('Tick the items that belong to the ID holder')
  }
  const total = priced.total
  const { applied, remaining, change } = applyLines(total, lines)
  if (remaining > 0) throw new Error(`${formatPeso(remaining)} still to pay. The order stays unpaid.`)
  for (const l of applied) {
    const ref = normRef(l.reference)
    if (ref && (await db.payments.where('reference').equals(ref).count()) > 0) throw new Error(`Reference ${ref} was already used on another payment`)
  }
  const ctx = await getSellContext(terminalId)
  if (!ctx) throw new Error('Selling needs an open business day and an open shift on this terminal')
  const at = new Date().toISOString()
  const order: Order = {
    id: newId(),
    branchId: ctx.day.branchId,
    terminalId,
    shiftId: ctx.shift.id,
    businessDayId: ctx.day.id,
    businessDate: ctx.day.date,
    invoiceNo: '', // set inside the transaction below so a failed save never uses up a number
    number: await nextOrderNumber(ctx.day.id),
    vatRegistered: vat,
    ...(buyer && (buyer.name.trim() || buyer.tin.trim()) && { buyer: { name: buyer.name.trim(), tin: buyer.tin.trim() } }),
    orderType: cart.orderType,
    name: cart.name.trim(),
    table: cart.table.trim(),
    lines: cart.lines,
    gross: priced.gross,
    total,
    ...(priced.discount && { discount: priced.discount }),
    status: 'paid',
    paidAt: at,
    cashierId: userId,
  }
  const payments: Payment[] = applied.map((l, i) => ({
    id: newId(),
    orderId: order.id,
    method: l.method,
    amount: l.amount,
    tendered: l.tendered,
    ...(l.reference && { reference: normRef(l.reference) }),
    ...(l.approvalCode && { approvalCode: normRef(l.approvalCode) }),
    ...(l.last4 && { last4: l.last4.trim() }),
    status: l.status,
    idempotencyKey: `${idempotencyKey}:${i}`,
    at,
    businessDate: order.businessDate,
    cashierId: userId,
  }))
  await db.transaction('rw', [db.orders, db.payments, db.outbox, db.discountLog, db.counters, db.queueItems, db.queueEvents, db.items, db.categories, db.approvals, db.users, db.settings], async () => {
    // A discount above the cashier's limit needs an unused supervisor approval; checked here so no screen can skip it.
    const approver = await consumeApproval(userId, 'discount', order.discount?.reduction ?? 0, order.id, approvalId)
    if (approver) order.discountApprovedBy = approver
    order.invoiceNo = formatInvoiceNo(ctx.terminal.invoicePrefix, await nextInvoiceSeq(terminalId))
    await db.orders.add(order)
    await createQueueItems(order, userId)
    const d = order.discount
    if (d) {
      const repeatId = (await db.discountLog.where('idNumber').equals(d.idNumber).and((r) => r.businessDate === order.businessDate).count()) > 0
      const row: DiscountLogEntry = {
        id: newId(), orderId: order.id, businessDate: order.businessDate, at, cashierId: userId, kind: d.kind, name: d.name, idNumber: d.idNumber,
        items: d.lines.map((l) => `${l.units}× ${l.name}`).join(', '), vatExempt: d.vatExempt, discountAmount: d.discountAmount, reduction: d.reduction, repeatId,
      }
      await db.discountLog.add(row)
      await db.outbox.add({ id: newId(), table: 'discountLog', recordId: row.id, at, synced: 0 })
    }
    await db.payments.bulkAdd(payments)
    await db.outbox.bulkAdd([order.id, ...payments.map((p) => p.id)].map((recordId, i) => ({
      id: newId(), table: i === 0 ? 'orders' : 'payments', recordId, at, synced: 0,
    })))
  })
  await audit({
    userId,
    action: 'order.paid',
    ref: order.id,
    detail: { number: order.number, total, change, payments: payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference, status: p.status })) },
  })
  if (order.discount) {
    const d = order.discount
    await audit({ userId, action: 'discount.statutory', ref: order.id, detail: { kind: d.kind, name: d.name, idNumber: d.idNumber, reduction: d.reduction } })
  }
  return { order, payments, change }
}

/** Per-terminal series: 1, 2, 3… Runs inside the sale's transaction, so numbers are never skipped or reused. */
async function nextInvoiceSeq(terminalId: string) {
  const id = `invoice:${terminalId}`
  const n = ((await db.counters.get(id))?.last ?? 0) + 1
  await db.counters.put({ id, last: n })
  return n
}

/** Records that an invoice was printed. The first print is the original; every later one is a REPRINT, audited, and needs a supervisor PIN unless the user may reprint. */
export async function logPrint(orderId: string, userId: string, approvalId?: string): Promise<'original' | 'reprint'> {
  const kind = (await db.invoicePrints.where('orderId').equals(orderId).count()) === 0 ? 'original' : 'reprint'
  let approverId: string | undefined
  if (kind === 'reprint') {
    // Someone without the reprint permission (a cashier) needs a supervisor PIN, once per reprint.
    approverId = await db.transaction('rw', db.approvals, db.users, db.settings, async () => await consumeApproval(userId, 'reprint', 0, orderId, approvalId, orderId))
  }
  await db.invoicePrints.add({ id: newId(), orderId, userId, at: new Date().toISOString(), kind, ...(approverId && { approvedBy: approverId }) })
  if (kind === 'reprint') await audit({ userId, approverId, action: 'invoice.reprint', ref: orderId })
  return kind
}

/** A supervisor confirms an e-wallet payment showed up in the merchant app. Verifying your own sale is flagged. */
export async function verifyPayment(paymentId: string, userId: string) {
  const p = await db.payments.get(paymentId)
  if (!p) throw new Error('Payment not found')
  if (p.status === 'verified') return
  await db.payments.update(paymentId, { status: 'verified', verifiedBy: userId, verifiedAt: new Date().toISOString() })
  await audit({ userId, action: 'payment.verified', ref: paymentId, detail: { orderId: p.orderId, amount: p.amount, reference: p.reference, selfApproved: p.cashierId === userId } })
}

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
