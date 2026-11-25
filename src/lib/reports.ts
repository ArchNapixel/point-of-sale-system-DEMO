import type { CashMovement, Deposit, GiftCardTx, Order, Payment, Refund, Shift, Tab } from '../db/db'
import { invoiceFigures } from './invoice'
import type { PayMethod } from './payments'

// Sales reports, rebuildable from history (rule 6). Gross = prices before discounts. Net = gross - discounts - voids - refunds.
// Voids and refunds count on the day they are given, not the day of the sale. Comps are shown apart: they are never in sales.
export type MethodRow = { collected: number; refunded: number; net: number }
export type ShiftRow = { shiftId: string; terminalId: string; cashierId: string; opening: number; expected: number; counted?: number; overShort?: number; note?: string; closed: boolean }
export type Report = {
  orders: number
  gross: number
  discounts: { seniorPwd: number; promo: number; staff: number; total: number }
  voids: { count: number; amount: number }
  refunds: { count: number; amount: number }
  net: number
  comps: { count: number; value: number }
  noSales: number
  walkouts: { count: number; amount: number } // tables that left without paying: a loss, kept apart from voids
  loyaltyRewards: { count: number; value: number } // free drinks given for stamps or points: loyalty expense, kept apart from comps
  giftCards: { sold: number; redeemed: number; outstanding: number } // sold = money taken for cards (a liability, not sales); outstanding = still on cards
  deliveryFees: number // rider fees charged to customers: collected, but never in sales
  channels: { channelId: string; name: string; orders: number; sales: number; commission: number; owed: number }[] // delivery app sales, the commission and what the app still owes (net)
  deposits: { taken: number; refunded: number; forfeited: number; held: number } // money taken before a sale: a liability until the order is paid
  seniorPwd: { count: number; vatExempt: number; reduction: number }
  vat: { vatable: number; vat: number; vatExempt: number; nonVatSales: number }
  payments: Record<PayMethod, MethodRow>
  pending: { count: number; amount: number }
  cash: { opening: number; sales: number; refunds: number; paidIn: number; paidOut: number; drops: number; expected: number }
  shifts: ShiftRow[] // each shift stands on its own: over and short are never netted against each other
}

const METHODS: PayMethod[] = ['cash', 'gcash', 'maya', 'card', 'transfer', 'deposit', 'platform', 'giftcard']
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0)

export function buildReport(i: {
  orders: Order[]; payments: Payment[]; refunds: Refund[]; moves: CashMovement[]; shifts: (Shift & { expectedCash: number })[]
  walkouts?: Tab[]
  giftSold?: GiftCardTx[]
  giftRedeemed?: GiftCardTx[]
  giftOutstanding?: number
  deposits?: Deposit[] // deposits taken, refunded or forfeited in scope
  heldDeposits?: Deposit[] // every deposit still owed to customers, whenever it was taken
  channelNames?: Map<string, string>
  refundedPayments?: Payment[] // payments of the orders refunded in scope, which may be sales from an earlier day
}): Report {
  const { orders, payments, refunds, moves, shifts } = i
  const refundedPayments = i.refundedPayments ?? payments
  const live = orders.filter((o) => o.status === 'paid')
  const gross = sum(orders, (o) => o.gross)
  const d = { seniorPwd: sum(orders, (o) => o.discount?.reduction ?? 0), promo: sum(orders, (o) => o.promo?.reduction ?? 0), staff: sum(orders, (o) => o.employee?.reduction ?? 0) }
  const voids = refunds.filter((r) => r.kind === 'void')
  const plain = refunds.filter((r) => r.kind === 'refund')
  const figs = live.map((o) => invoiceFigures(o))

  const byMethod = Object.fromEntries(METHODS.map((m) => [m, { collected: 0, refunded: 0, net: 0 }])) as Report['payments']
  for (const p of payments) byMethod[p.method].collected += p.amount
  for (const r of refunds) {
    if (r.kind === 'refund' && r.method !== 'original') byMethod[r.method].refunded += r.amount
    else for (const p of refundedPayments.filter((x) => x.orderId === r.orderId)) byMethod[p.method].refunded += p.amount // a void goes back the way it was paid
  }
  for (const m of METHODS) byMethod[m].net = byMethod[m].collected - byMethod[m].refunded
  const pending = payments.filter((p) => p.status === 'pending')

  const cashSales = sum(payments.filter((p) => p.method === 'cash'), (p) => p.amount)
  const moved = (k: CashMovement['kind']) => sum(moves.filter((m) => m.kind === k), (m) => m.amount)

  return {
    orders: live.length,
    gross,
    discounts: { ...d, total: d.seniorPwd + d.promo + d.staff },
    voids: { count: voids.length, amount: sum(voids, (r) => r.amount) },
    refunds: { count: plain.length, amount: sum(plain, (r) => r.amount) },
    net: gross - d.seniorPwd - d.promo - d.staff - sum(refunds, (r) => r.amount),
    comps: { count: sum(live, (o) => (o.comps ?? []).filter((c) => c.reason !== 'loyalty-reward').length), value: sum(live, (o) => sum((o.comps ?? []).filter((c) => c.reason !== 'loyalty-reward'), (c) => c.value)) },
    loyaltyRewards: { count: sum(live, (o) => (o.comps ?? []).filter((c) => c.reason === 'loyalty-reward').length), value: sum(live, (o) => sum((o.comps ?? []).filter((c) => c.reason === 'loyalty-reward'), (c) => c.value)) },
    giftCards: { sold: sum(i.giftSold ?? [], (t) => t.amount), redeemed: sum(i.giftRedeemed ?? [], (t) => -t.amount), outstanding: i.giftOutstanding ?? 0 },
    noSales: moves.filter((m) => m.kind === 'no-sale').length,
    deliveryFees: sum(live, (o) => o.deliveryFee ?? 0),
    channels: [...new Set(live.flatMap((o) => (o.channelId ? [o.channelId] : [])))].map((id) => {
      const os = live.filter((o) => o.channelId === id)
      const sales = sum(os, (o) => o.total)
      const commission = sum(os, (o) => Math.round((o.total * (o.commissionPct ?? 0)) / 100))
      return { channelId: id, name: i.channelNames?.get(id) ?? os[0].channelName ?? '?', orders: os.length, sales, commission, owed: sales - commission }
    }),
    deposits: {
      taken: sum(i.deposits ?? [], (d) => d.amount),
      refunded: sum((i.deposits ?? []).filter((d) => d.status === 'refunded'), (d) => d.amount),
      forfeited: sum((i.deposits ?? []).filter((d) => d.status === 'forfeited'), (d) => d.amount),
      held: sum(i.heldDeposits ?? [], (d) => d.amount),
    },
    walkouts: { count: (i.walkouts ?? []).length, amount: sum(i.walkouts ?? [], (t) => t.walkout?.amount ?? 0) },
    seniorPwd: { count: live.filter((o) => o.discount).length, vatExempt: sum(live, (o) => o.discount?.vatExempt ?? 0), reduction: sum(live, (o) => o.discount?.reduction ?? 0) },
    vat: {
      vatable: sum(figs, (f) => (f.vatRegistered ? f.vatable : 0)),
      vat: sum(figs, (f) => (f.vatRegistered ? f.vat : 0)),
      vatExempt: sum(figs, (f) => (f.vatRegistered ? f.vatExempt : 0)),
      nonVatSales: sum(figs, (f) => (f.vatRegistered ? 0 : f.sales - f.other)),
    },
    payments: byMethod,
    pending: { count: pending.length, amount: sum(pending, (p) => p.amount) },
    cash: {
      opening: sum(shifts, (s) => s.openingTotal),
      sales: cashSales,
      refunds: sum(refunds, (r) => r.cashAmount),
      paidIn: moved('paid-in'),
      paidOut: moved('paid-out'),
      drops: moved('drop'),
      expected: sum(shifts, (s) => s.expectedCash),
    },
    shifts: shifts.map((s) => ({
      shiftId: s.id, terminalId: s.terminalId, cashierId: s.cashierId, opening: s.openingTotal, expected: s.expectedCash,
      ...(s.closeCounted !== undefined && { counted: s.closeCounted, overShort: s.overShort }), ...(s.overShortNote && { note: s.overShortNote }), closed: !!s.closedAt,
    })),
  }
}
