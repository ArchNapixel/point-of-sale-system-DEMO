import { db, type DiscountLogEntry, type Order, type Payment } from './db'
import { consumeApproval } from './approvals'
import { createQueueItems } from './queue'
import { settleBillPart } from './tabs'
import { heldDeposit } from './preorders'
import { earnOrder, redeemRewards } from './loyalty'
import { redeemCard } from './giftcards'
import { lineTotal } from '../lib/cart'
import { alertAfterSale, deductSale, syncModifierAvailability } from './stock'
import { formatInvoiceNo } from '../lib/invoice'
import { newId } from '../lib/id'
import { cartCount, compValue, compTotal, rewardUnits, type Cart } from '../lib/cart'
import { checkReason } from '../lib/reasons'
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
  terminalId: string, userId: string, cart: Cart, lines: PayLine[], idempotencyKey: string, buyer?: { name: string; tin: string }, approvals: { discount?: string; comp?: string } = {},
  tab?: { tabId: string; billId: string; partId: string }, // paying one part of a tab's bill: its drinks and stock were taken when each round was sent
  fulfil?: { preOrderId: string }, // collecting a pre-order: its deposit is applied, and the bar may already have made it
) {
  const prior = await db.orders.where('idempotencyKey').equals(idempotencyKey).first()
  if (prior) return { order: prior, payments: await db.payments.where('orderId').equals(prior.id).toArray() }
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  for (const l of cart.lines) if (l.comp) checkReason(l.comp.code, l.comp.note)
  const vat = await getSetting('vatRegistered')
  const priced = priceCart(cart, vat, { promos: (await db.promos.toArray()).filter((p) => p.active), employeePct: await getSetting('employeeDiscountPct') })
  if (cart.discount) {
    validateStatutory(cart.discount)
    if (!priced.discount && !priced.statutoryLost) throw new Error('Tick the items that belong to the ID holder') // lost = a better price applied instead
  }
  const total = priced.total
  // A delivery fee is paid with the order but is never sales and is never discounted.
  const fee = cart.deliveryFee ?? 0
  if (!Number.isInteger(fee) || fee < 0) throw new Error('The delivery fee must be whole centavos')
  const channel = cart.channelId ? await db.channels.get(cart.channelId) : undefined
  if (cart.channelId && !channel?.active) throw new Error('That delivery app is switched off')
  const pre = fulfil ? await db.preOrders.get(fulfil.preOrderId) : undefined
  if (fulfil) {
    if (!pre || (pre.status !== 'booked' && pre.status !== 'preparing')) throw new Error('This pre-order is not waiting to be collected')
    const same = cart.lines.length === pre.lines.length && cart.lines.every((l, k) => l.id === pre.lines[k].id) && fee === (pre.deliveryFee ?? 0)
    if (!same || priced.gross !== pre.lines.reduce((s, l) => s + lineTotal(l), 0)) throw new Error('The order no longer matches the pre-order. Start again from the pre-order.')
  }
  const { applied, remaining, change } = applyLines(total + fee, lines)
  if (remaining > 0) throw new Error(`${formatPeso(remaining)} still to pay. The order stays unpaid.`)
  if (channel ? applied.some((a) => a.method !== 'platform') : applied.some((a) => a.method === 'platform')) {
    throw new Error(channel ? `${channel.name} orders are paid by the app, not at the till` : 'Delivery app payment is only for delivery app orders')
  }
  const held = pre ? await heldDeposit(pre.id) : undefined
  const customer = cart.customerId ? await db.customers.get(cart.customerId) : undefined
  if (cart.customerId && !customer?.active) throw new Error('That customer profile is not active')
  const rewards = rewardUnits(cart)
  if (rewards > 0 && !customer) throw new Error('A loyalty reward needs a customer. Look one up first.')
  const depLines = applied.filter((a) => a.method === 'deposit')
  if (held) {
    if (depLines.length !== 1 || depLines[0].amount !== held.amount || normRef(depLines[0].reference) !== normRef(held.id)) throw new Error(`Apply the ${formatPeso(held.amount)} deposit to this bill`)
  } else if (depLines.length > 0) throw new Error('There is no deposit to apply')
  for (const l of applied) {
    const ref = normRef(l.reference)
    // A transfer or e-wallet reference is used once, ever. Gift cards and deposits are spent in parts, so theirs repeat.
    if (ref && ['gcash', 'maya', 'transfer'].includes(l.method) && (await db.payments.where('reference').equals(ref).count()) > 0) throw new Error(`Reference ${ref} was already used on another payment`)
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
    ...(priced.promo && { promo: priced.promo }),
    ...(priced.employee && { employee: priced.employee }),
    ...(cart.lines.some((l) => l.comp) && {
      comps: cart.lines.filter((l) => l.comp).map((l) => ({ lineId: l.id, name: l.name, qty: l.qty, value: compValue(l), reason: l.comp!.code, ...(l.comp!.note.trim() && { note: l.comp!.note.trim() }) })),
    }),
    idempotencyKey,
    ...(tab && { tabId: tab.tabId, billId: tab.billId }),
    ...(fee > 0 && { deliveryFee: fee }),
    ...(channel && { channelId: channel.id, channelName: channel.name, commissionPct: channel.commissionPct }),
    ...(pre && { preOrderId: pre.id }),
    ...(customer && { customerId: customer.id }),
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
  let sale: Awaited<ReturnType<typeof deductSale>> | undefined
  let earned = 0
  await db.transaction('rw', [db.orders, db.payments, db.outbox, db.discountLog, db.counters, db.queueItems, db.queueEvents, db.items, db.categories, db.approvals, db.users, db.settings, db.promos, db.promoUses, db.stockMoves, db.recipes, db.ingredients, db.tabs, db.bills, db.preOrders, db.deposits, db.channels, db.customers, db.loyaltyLedger, db.giftCards, db.giftCardTx], async () => {
    const emp = order.employee
    if (emp) {
      const who = await db.users.get(emp.employeeId)
      if (!who?.active) throw new Error('Pick an active staff member for the staff discount')
      // A cap per person per business day, so one person cannot drain it.
      const cap = await getSetting('employeeDiscountDailyCapCentavos')
      const used = (await db.orders.where('businessDate').equals(order.businessDate).filter((o) => o.status === 'paid' && o.employee?.employeeId === emp.employeeId).toArray())
        .reduce((s, o) => s + (o.employee?.reduction ?? 0), 0)
      if (used + emp.reduction > cap) throw new Error(`${emp.name} has used ${formatPeso(used)} of the ${formatPeso(cap)} staff discount allowed per day`)
    }
    const pr = order.promo
    if (pr?.code) {
      const promo = await db.promos.get(pr.promoId)
      if (promo && promo.maxUses > 0 && (await db.promoUses.where('promoId').equals(promo.id).count()) >= promo.maxUses) throw new Error(`Code ${pr.code} was already used. Remove it to continue.`)
    }
    // A discount above the cashier's limit needs an unused supervisor approval; checked here so no screen can skip it.
    const approver = await consumeApproval(userId, 'discount', order.discount?.reduction ?? order.employee?.reduction ?? 0, order.id, approvals.discount)
    if (approver) order.discountApprovedBy = approver
    // Same for a comp above the cashier's limit. Stock still deducts (3C) and the value is kept as a comp, not a discount.
    const compApprover = await consumeApproval(userId, 'comp', compTotal(cart), order.id, approvals.comp)
    if (compApprover) order.compApprovedBy = compApprover
    order.invoiceNo = formatInvoiceNo(ctx.terminal.invoicePrefix, await nextInvoiceSeq(terminalId))
    await db.orders.add(order)
    // Gift cards and loyalty rewards are spent in the same save as the order, so a card can never go below zero or a reward be used twice.
    for (const g of applied.filter((a) => a.method === 'giftcard')) await redeemCard(g.reference!, g.amount, order.id, userId)
    if (customer && rewards > 0) await redeemRewards(order.id, customer.id, rewards, userId)
    if (customer) earned = await earnOrder(order, customer.id, userId)
    if (held) await db.deposits.update(held.id, { status: 'applied', appliedOrderId: order.id })
    if (pre) await db.preOrders.update(pre.id, { status: 'fulfilled', orderId: order.id })
    if (tab) {
      await settleBillPart(order, tab.billId, tab.partId, userId)
    } else if (pre?.status === 'preparing') {
      // the bar already made it and the ingredients were taken when it started
    } else {
      await createQueueItems(order, userId)
      sale = await deductSale(order, userId) // stock goes down in the same save as the order; it may go negative, never blocks
    }
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
    if (pr) {
      await db.promoUses.add({ id: newId(), promoId: pr.promoId, promoName: pr.name, ...(pr.code && { code: pr.code }), orderId: order.id, terminalId, businessDate: order.businessDate, at, amount: pr.reduction })
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
  if (sale) await alertAfterSale(sale.crossed, userId)
  await syncModifierAvailability(userId).catch(() => {}) // best effort: a stock hiccup must never fail a paid sale
  if (order.discount) {
    const d = order.discount
    await audit({ userId, action: 'discount.statutory', ref: order.id, detail: { kind: d.kind, name: d.name, idNumber: d.idNumber, reduction: d.reduction } })
  }
  return { order, payments, change, earned }
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
