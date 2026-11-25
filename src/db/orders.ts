import { db, type DiscountLogEntry, type Order, type Payment } from './db'
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
export async function payOrder(terminalId: string, userId: string, cart: Cart, lines: PayLine[], idempotencyKey: string) {
  const prior = await db.payments.where('idempotencyKey').equals(`${idempotencyKey}:0`).first()
  if (prior) return { order: (await db.orders.get(prior.orderId))!, payments: await db.payments.where('orderId').equals(prior.orderId).toArray() }
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  const priced = priceCart(cart, await getSetting('vatRegistered'))
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
    number: await nextOrderNumber(ctx.day.id),
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
  await db.transaction('rw', db.orders, db.payments, db.outbox, db.discountLog, async () => {
    await db.orders.add(order)
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
