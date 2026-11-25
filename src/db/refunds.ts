import { db, type Refund } from './db'
import { newId } from '../lib/id'
import { lineTotal } from '../lib/cart'
import { checkReason } from '../lib/reasons'
import type { PayMethod } from '../lib/payments'
import { audit } from './audit'
import { consumeApproval } from './approvals'
import { getSellContext } from './shifts'
import { returnVoided } from './stock'
import { reverseEarn } from './loyalty'
import { creditCard } from './giftcards'

/** Each order line with what the customer paid for it (after any Senior/PWD discount) and how much is still refundable. */
export async function refundableLines(orderId: string) {
  const order = await db.orders.get(orderId)
  if (!order) throw new Error('Order not found')
  const refunds = await db.refunds.where('orderId').equals(orderId).toArray()
  return order.lines.map((line) => {
    const d = order.discount?.lines.find((x) => x.lineId === line.id)
    // What the customer actually paid for the line: after Senior/PWD, a promo or a staff discount (only one of them applies).
    const off = (d ? d.base - d.pay : 0) + (order.promo?.lines.find((x) => x.lineId === line.id)?.amount ?? 0) + (order.employee?.lines.find((x) => x.lineId === line.id)?.amount ?? 0)
    const net = lineTotal(line) - off
    const mine = refunds.flatMap((r) => r.lines).filter((x) => x.lineId === line.id)
    const doneUnits = mine.reduce((s, x) => s + x.units, 0)
    return { line, net, doneUnits, doneAmount: mine.reduce((s, x) => s + x.amount, 0), remainingUnits: line.qty - doneUnits }
  })
}

export type RefundRow = Awaited<ReturnType<typeof refundableLines>>[number]
/** Refund for some units of a line. The last units take whatever is left, so the pieces always add up to what was paid. */
export const unitsAmount = (r: RefundRow, units: number) => (units === r.remainingUnits ? r.net - r.doneAmount : Math.round((r.net * units) / r.line.qty))

export function pickedAmount(rows: RefundRow[], picks: Record<string, number>) {
  return rows.reduce((s, r) => s + ((picks[r.line.id] ?? 0) > 0 ? unitsAmount(r, picks[r.line.id]) : 0), 0)
}

type Common = { orderId: string; terminalId: string; userId: string; reasonCode: string; reasonNote?: string; approvalId?: string; idempotencyKey: string }

async function record(kind: 'void' | 'refund', i: Common & { picks?: Record<string, number>; method?: PayMethod; reference?: string }) {
  const prior = await db.refunds.where('idempotencyKey').equals(i.idempotencyKey).first()
  if (prior) return prior
  checkReason(i.reasonCode, i.reasonNote)
  const ctx = await getSellContext(i.terminalId)
  if (!ctx) throw new Error('Refunds come out of an open shift on this terminal. Open the business day and a shift first.')
  const refund = await db.transaction('rw', [db.orders, db.refunds, db.queueItems, db.payments, db.approvals, db.users, db.settings, db.outbox, db.stockMoves, db.loyaltyLedger, db.giftCards, db.giftCardTx, db.customers], async () => {
    const order = await db.orders.get(i.orderId)
    if (!order || order.status !== 'paid') throw new Error('This order is already voided')
    // ponytail: a bill paid from a tab was made when each round was sent, so it is refunded (as waste), never voided.
    if (kind === 'void' && (order.tabId || (order.preOrderId && (await db.queueItems.where('orderId').equals(order.preOrderId).count()) > 0))) {
      throw new Error('This was made ahead (a tab or a pre-order) and the drinks were already made. Use Refund instead.')
    }
    const rows = await refundableLines(i.orderId)
    const items = await db.queueItems.where('orderId').equals(i.orderId).toArray()
    const started = items.some((q) => q.status !== 'queued' && q.status !== 'void')
    let lines: Refund['lines']
    let cashAmount: number
    if (kind === 'void') {
      if (started) throw new Error('Drinks are already being made. Use Refund instead: it is recorded as waste.')
      if (rows.some((r) => r.doneUnits > 0)) throw new Error('Part of this order was already refunded. Refund the rest instead.')
      lines = rows.filter((r) => r.net > 0).map((r) => ({ lineId: r.line.id, units: r.line.qty, amount: r.net }))
      // A void hands every payment back the way it came; the cash part leaves the drawer.
      cashAmount = (await db.payments.where('orderId').equals(i.orderId).toArray()).filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0)
    } else {
      lines = rows.flatMap((r) => {
        const u = i.picks?.[r.line.id] ?? 0
        if (u <= 0) return []
        if (!Number.isInteger(u) || u > r.remainingUnits) throw new Error(`Only ${r.remainingUnits} of ${r.line.name} left to refund`)
        return r.net > 0 ? [{ lineId: r.line.id, units: u, amount: unitsAmount(r, u) }] : []
      })
      if (lines.length === 0) throw new Error('Pick what to refund')
      cashAmount = i.method === 'cash' ? lines.reduce((s, l) => s + l.amount, 0) : 0
    }
    const amount = lines.reduce((s, l) => s + l.amount, 0)
    const id = newId()
    const approvedBy = await consumeApproval(i.userId, kind, amount, id, i.approvalId, i.orderId)
    if (!approvedBy) throw new Error('This needs a supervisor PIN')
    const r: Refund = {
      id, orderId: i.orderId, invoiceNo: order.invoiceNo, kind, lines, amount, method: kind === 'void' ? 'original' : i.method ?? 'cash', cashAmount,
      ...(i.reference?.trim() && { reference: i.reference.trim().toUpperCase() }), reasonCode: i.reasonCode, ...(i.reasonNote?.trim() && { reasonNote: i.reasonNote.trim() }),
      requestedBy: i.userId, approvedBy, terminalId: i.terminalId, shiftId: ctx.shift.id,
      businessDate: ctx.day.date, // dated today, not the day of the sale
      at: new Date().toISOString(), madeBefore: started, idempotencyKey: i.idempotencyKey,
    }
    await db.refunds.add(r)
    // Stamps or points earned on what is refunded are taken back (all of it for a void).
    await reverseEarn(order, amount, kind === 'void', id, i.userId)
    if (kind === 'void') {
      for (const p of await db.payments.where('orderId').equals(i.orderId).toArray()) if (p.method === 'giftcard') await creditCard(p.reference!, p.amount, i.orderId, i.userId)
    } else if (i.method === 'giftcard') {
      if (!i.reference?.trim()) throw new Error('Enter the gift card number to put the refund on')
      await creditCard(i.reference, amount, i.orderId, i.userId)
    }
    await db.outbox.add({ id: newId(), table: 'refunds', recordId: r.id, at: r.at, synced: 0 })
    if (kind === 'void') {
      await db.orders.update(i.orderId, { status: 'void' })
      await returnVoided(i.orderId, i.userId) // nothing was made: its ingredients go back
      await db.queueItems.where('orderId').equals(i.orderId).modify({ status: 'void' }) // nothing made: tickets disappear from the bar
    }
    return r
  })
  await audit({
    userId: i.userId, approverId: refund.approvedBy, action: `order.${kind}`, ref: i.orderId,
    detail: { amount: refund.amount, reason: refund.reasonCode, note: refund.reasonNote, method: refund.method, invoiceNo: refund.invoiceNo, selfApproved: refund.approvedBy === i.userId },
  })
  return refund
}

/** Whole order, after payment, before anything was made. Supervisor PIN + reason. The invoice number stays used and is marked VOID. */
export const voidOrder = (i: Common) => record('void', i)

/** After the drink was made or served: whole or part, by line and units, to cash or the original e-wallet/card. Supervisor PIN + reason. */
export const refundOrder = (i: Common & { picks: Record<string, number>; method: PayMethod; reference?: string }) => record('refund', i)
