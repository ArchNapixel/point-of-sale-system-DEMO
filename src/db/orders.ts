import { db, type Order, type Payment } from './db'
import { newId } from '../lib/id'
import { cartCount, cartTotal, type Cart } from '../lib/cart'
import { audit } from './audit'
import { getSellContext } from './shifts'

/**
 * Takes cash for a cart and saves it as a paid order. Tendered must cover the total, otherwise nothing is saved
 * (the cart stays unpaid). Calling again with the same idempotency key returns the first result.
 * ponytail: cash only; split tender and partial payment come in 1G.
 */
export async function payCash(terminalId: string, userId: string, cart: Cart, tendered: number, idempotencyKey: string) {
  const prior = await db.payments.where('idempotencyKey').equals(idempotencyKey).first()
  if (prior) return { order: (await db.orders.get(prior.orderId))!, payment: prior }
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  const total = cartTotal(cart)
  if (!Number.isInteger(tendered) || tendered < total) throw new Error('Cash handed over is less than the total. The order stays unpaid.')
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
    total,
    status: 'paid',
    paidAt: at,
    cashierId: userId,
  }
  const payment: Payment = {
    id: newId(), orderId: order.id, method: 'cash', amount: total, tendered, idempotencyKey, at, businessDate: order.businessDate, cashierId: userId,
  }
  await db.transaction('rw', db.orders, db.payments, db.outbox, async () => {
    await db.orders.add(order)
    await db.payments.add(payment)
    await db.outbox.bulkAdd([
      { id: newId(), table: 'orders', recordId: order.id, at, synced: 0 },
      { id: newId(), table: 'payments', recordId: payment.id, at, synced: 0 },
    ])
  })
  await audit({ userId, action: 'order.paid', ref: order.id, detail: { number: order.number, total, tendered, method: 'cash' } })
  return { order, payment }
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
