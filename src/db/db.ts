import Dexie, { type EntityTable } from 'dexie'
import type { Role } from '../lib/roles'
import type { Cart } from '../lib/cart'
import type { QueueStatus, Station } from '../lib/queue'
import type { ApprovalAction } from '../lib/approval'
import type { PayMethod } from '../lib/payments'
import type { AppliedEmployee, AppliedPromo, OrderDiscount } from '../lib/discount'
import type { Promo } from '../lib/promos'
import type { Report } from '../lib/reports'
import type { BaseUnit, IngredientUnit } from '../lib/units'
import type { RecipeLine } from '../lib/recipes'

// Every row has a device-made UUID id. Archive via `active: false`, never delete (rule 3).
export type Branch = { id: string; name: string; active: boolean }
export type Terminal = { id: string; branchId: string; name: string; invoicePrefix: string; active: boolean }
export type User = { id: string; name: string; role: Role; pinHash: string; active: boolean }
export type Setting = { key: string; value: string | number | boolean }
export type AuditEntry = {
  id: string
  at: string // ISO timestamp
  businessDate: string // YYYY-MM-DD, separate from timestamp (rule 4)
  userId: string
  approverId?: string
  action: string
  ref?: string
  detail?: Record<string, unknown>
}
// station: where items in this category are made. Missing = bar. ponytail: per category; add a per-item override when a mixed category needs it.
export type Category = { id: string; name: string; sort: number; active: boolean; station?: Station }
// ponytail: sold-out is one flag per item. Per-branch / per-channel sold-out comes with delivery channels (4B).
export type Item = {
  id: string
  categoryId: string
  name: string
  soldOut: boolean
  active: boolean
  groupIds?: string[] // modifier groups offered on this item, in display order
}
// Min/max count the distinct options picked in the group. required = min >= 1.
export type ModifierGroup = { id: string; name: string; min: number; max: number; sort: number; active: boolean }
export type Modifier = {
  id: string
  groupId: string
  name: string
  price: number // centavos per unit, used when no size-specific price matches
  sizePrices: Record<string, number> // lowercase size -> centavos, e.g. { "12 oz": 3000, "16 oz": 4000 }
  freeQty: number // first N units are free (1 syrup pump free, then paid)
  maxQty: number // most units of this option per drink (pumps)
  soldOut: boolean
  sort: number
  active: boolean
}
// A variant is one sellable size/temperature of an item and carries the base price in centavos.
export type Variant = { id: string; itemId: string; size?: string; temp?: 'hot' | 'iced'; price: number; active: boolean }
// A cart set aside while the cashier serves someone else. Never deleted: resumed or discarded instead.
export type HeldCart = {
  id: string
  terminalId: string
  shiftId: string
  heldBy: string
  heldAt: string
  label: string
  cart: Cart
  status: 'held' | 'resumed' | 'discarded'
}
// A paid order. Unpaid orders are still carts (held or on screen); an Order row exists only once payments cover the total.
export type Order = {
  id: string
  branchId: string
  terminalId: string
  shiftId: string
  businessDayId: string
  businessDate: string
  invoiceNo: string // e.g. T1-000123, unbroken per terminal; voids keep their number
  number: number // order number called out to the customer, per business day
  vatRegistered: boolean // the store setting at the time of sale; decides how the invoice is laid out
  buyer?: { name: string; tin: string } // optional, for a business invoice
  orderType: Cart['orderType']
  name: string
  table: string
  lines: Cart['lines'] // copied snapshot (rule 2)
  gross: number // centavos before any discount
  total: number // centavos the customer pays (gross - discount.reduction)
  discount?: OrderDiscount
  discountApprovedBy?: string // set when the discount (Senior/PWD or staff) was above the cashier's limit
  promo?: AppliedPromo // the one promo that applied (never stacked with a discount)
  employee?: AppliedEmployee // staff discount
  comps?: { lineId: string; name: string; qty: number; value: number; reason: string; note?: string }[] // lines given free on purpose; value = what they would have cost
  compApprovedBy?: string
  idempotencyKey: string // one tap = one order (also covers ₱0 comped orders, which have no payment rows)
  status: 'paid' | 'void' // a voided order keeps its invoice number
  paidAt: string
  cashierId: string
}
// One row per Senior/PWD discount given: the month-end tax-claim record. repeatId flags an ID number already used that business date.
export type DiscountLogEntry = {
  id: string
  orderId: string
  businessDate: string
  at: string
  cashierId: string
  kind: OrderDiscount['kind']
  name: string
  idNumber: string
  items: string // e.g. "1× Latte"
  vatExempt: number
  discountAmount: number
  reduction: number
  repeatId: boolean
}
// One bar/kitchen ticket row per order line, created when the order is paid. Names and options are copied (rule 2).
// ponytail: queue rows are local to this browser; sharing the queue between terminals comes with sync (4x).
export type QueueItem = {
  id: string
  orderId: string
  orderNumber: number
  orderLabel: string // customer name or table
  orderType: string
  lineId: string
  station: Exclude<Station, 'none'>
  name: string
  variantLabel: string
  mods: string[]
  notes: string[]
  allergy: string
  qty: number
  status: QueueStatus
  statusAt: string
  prevStatus?: QueueStatus // set only while an undo is possible
  rush: boolean
  rushReason?: string
  createdAt: string
  remakeOf?: string // this ticket replaces a spilled or wrong one
  wasted?: boolean // made but not sold: stock counts it as waste (3C)
}
// Status changes are events: who, when (rule 6).
export type QueueEvent = { id: string; itemId: string; status: QueueStatus; userId: string; at: string; note?: string }
// A second person's PIN for a sensitive action: who asked, who approved, on which terminal, when (rule 2).
export type Approval = {
  id: string
  action: ApprovalAction
  requesterId: string
  approverId: string
  terminalId: string
  at: string
  businessDate: string
  amount: number // centavos the approval covers (0 when the action has no amount)
  ref?: string // e.g. the order id being reprinted
  selfApproved: boolean // requester and approver are the same person: flagged in the approvals report
  usedFor?: string // set once an action has used it; an approval is good for one action
}
// Void = whole order, before anything was made. Refund = after it was made or served, whole or partial. Kept apart in every report.
// Dated the day it is given (not the sale's day) and linked to the original invoice. cashAmount is what left the drawer.
export type Refund = {
  id: string
  orderId: string
  invoiceNo: string
  kind: 'void' | 'refund'
  lines: { lineId: string; units: number; amount: number }[]
  amount: number
  method: PayMethod | 'original' // 'original' = a void hands every payment back the way it came
  cashAmount: number
  reference?: string
  reasonCode: string
  reasonNote?: string
  requestedBy: string
  approvedBy: string
  terminalId: string
  shiftId: string
  businessDate: string
  at: string
  madeBefore: boolean // something was already made: the drinks are waste, not returned stock
  idempotencyKey: string
}
// A spilled or wrongly made ticket re-made. No money moves; the first cup is waste.
export type Remake = {
  id: string; itemId: string; newItemId: string; orderId: string; name: string; station: string; qty: number
  reasonCode: string; reasonNote?: string; userId: string; businessDate: string; at: string
}
// Where a promo was used: a log per use, so a voucher code shows who got it, when and on which order.
export type PromoUse = { id: string; promoId: string; promoName: string; code?: string; orderId: string; terminalId: string; businessDate: string; at: string; amount: number }
// The end-of-day (Z) report, frozen when the day closed. Later changes never rewrite it.
export type ZReport = { id: string; businessDayId: string; branchId: string; date: string; at: string; by: string; report: Report }
// Clock-in/out for payroll hours (payroll itself is out of scope). edits keeps what a supervisor changed and why.
export type TimeEntry = {
  id: string
  userId: string
  terminalId: string
  inAt: string
  outAt?: string
  businessDate: string
  edits?: { at: string; by: string; reason: string; was: { inAt: string; outAt?: string } }[]
}
// What the café buys and uses up. Counted in one base unit; other units (kg, pump, case) convert to it. Archive, never delete (rule 3).
export type Ingredient = { id: string; name: string; baseUnit: BaseUnit; units: IngredientUnit[]; active: boolean }
// One version of a recipe. Saving makes a new version; old ones stay so old sales keep what they used (rule 6).
export type Recipe = { id: string; kind: 'variant' | 'modifier'; refId: string; version: number; lines: RecipeLine[]; at: string; by: string }
export type InvoicePrint = { id: string; orderId: string; userId: string; at: string; kind: 'original' | 'reprint'; approvedBy?: string }
export type Payment = {
  id: string
  orderId: string
  method: PayMethod
  amount: number // centavos applied to the order
  tendered: number // cash handed over; change = tendered - amount (same as amount for non-cash)
  reference?: string // GCash/Maya reference number, uppercase; a reference can be used once, ever
  approvalCode?: string // card
  last4?: string // card
  status: 'verified' | 'pending' // e-wallet payments stay pending until a supervisor sees them in the merchant app
  verifiedBy?: string
  verifiedAt?: string
  idempotencyKey: string // unique: a double tap or retry returns the first payment (rule 5)
  at: string
  businessDate: string
  cashierId: string
}
export type Counter ={ id: string; last: number }
export type Denoms = Record<string, number> // denomination key -> piece count (see shifts.ts DENOMS)
export type BusinessDay = {
  id: string
  branchId: string
  date: string // business date, YYYY-MM-DD
  openedBy: string
  openedAt: string
  closedAt?: string
  closedBy?: string
}
export type Shift = {
  id: string
  terminalId: string
  businessDayId: string
  cashierId: string
  openedAt: string
  openingTotal: number // centavos counted by the opener
  expectedFloat: number // centavos the previous closer left (or the float setting)
  floatGap: number // openingTotal - expectedFloat
  closedAt?: string
  closedBy?: string
  lateClose?: boolean // closed by a supervisor, not by the cashier's own close
  lateCloseReason?: string
  leftInDrawer?: number // centavos left for the next opener; set by the normal close (1K)
  expectedCash?: number // opening count + cash sales, worked out when the closing count is submitted
  closeCounted?: number // the final closing count (centavos)
  overShort?: number // closeCounted - expectedCash; reported per shift, never netted against other shifts
  overShortNote?: string // required when past the tolerance
}
// Cash that moved without a sale: a drop to the safe, a paid-out, a paid-in, or the drawer opened with no sale.
export type CashMovement = {
  id: string
  shiftId: string
  terminalId: string
  kind: 'drop' | 'paid-out' | 'paid-in' | 'no-sale'
  amount: number // centavos; 0 for a no-sale open
  reason: string
  receiptRef?: string // receipt number or note for a paid-out (a photo can come later)
  userId: string // the cashier who owns the drawer
  approvedBy: string
  businessDate: string
  at: string
  idempotencyKey: string
}
export type CashCount = {
  id: string
  shiftId: string
  kind: 'open' | 'close'
  attempt?: number // closing counts: 1, then 2 if the cashier used their one recount. Both are kept.
  countedBy: string
  at: string
  denoms: Denoms
  total: number // centavos
}
// Outbox: records waiting to sync. Server ignores duplicate ids/idempotency keys.
// synced: 0 = pending, 1 = synced (booleans aren't indexable in IndexedDB)
export type OutboxItem = { id: string; table: string; recordId: string; at: string; synced: number }

export const db = new Dexie('demo-pos') as Dexie & {
  branches: EntityTable<Branch, 'id'>
  terminals: EntityTable<Terminal, 'id'>
  users: EntityTable<User, 'id'>
  settings: EntityTable<Setting, 'key'>
  auditLog: EntityTable<AuditEntry, 'id'>
  outbox: EntityTable<OutboxItem, 'id'>
  businessDays: EntityTable<BusinessDay, 'id'>
  shifts: EntityTable<Shift, 'id'>
  cashCounts: EntityTable<CashCount, 'id'>
  categories: EntityTable<Category, 'id'>
  items: EntityTable<Item, 'id'>
  variants: EntityTable<Variant, 'id'>
  modifierGroups: EntityTable<ModifierGroup, 'id'>
  modifiers: EntityTable<Modifier, 'id'>
  heldCarts: EntityTable<HeldCart, 'id'>
  counters: EntityTable<Counter, 'id'>
  orders: EntityTable<Order, 'id'>
  payments: EntityTable<Payment, 'id'>
  discountLog: EntityTable<DiscountLogEntry, 'id'>
  invoicePrints: EntityTable<InvoicePrint, 'id'>
  approvals: EntityTable<Approval, 'id'>
  refunds: EntityTable<Refund, 'id'>
  promos: EntityTable<Promo, 'id'>
  zReports: EntityTable<ZReport, 'id'>
  timeEntries: EntityTable<TimeEntry, 'id'>
  ingredients: EntityTable<Ingredient, 'id'>
  recipes: EntityTable<Recipe, 'id'>
  promoUses: EntityTable<PromoUse, 'id'>
  cashMovements: EntityTable<CashMovement, 'id'>
  remakes: EntityTable<Remake, 'id'>
  queueItems: EntityTable<QueueItem, 'id'>
  queueEvents: EntityTable<QueueEvent, 'id'>
}

db.version(1).stores({
  branches: 'id',
  terminals: 'id, branchId',
  users: 'id, role',
  settings: 'key',
  auditLog: 'id, businessDate, userId, action',
  outbox: 'id, recordId, synced',
})
db.version(2).stores({
  businessDays: 'id, branchId, date',
  shifts: 'id, terminalId, businessDayId',
  cashCounts: 'id, shiftId',
})
db.version(3).stores({
  categories: 'id',
  items: 'id, categoryId',
  variants: 'id, itemId',
})
db.version(4).stores({
  modifierGroups: 'id',
  modifiers: 'id, groupId',
})
db.version(5).stores({
  heldCarts: 'id, terminalId, shiftId, status',
  counters: 'id',
})
db.version(6).stores({
  orders: 'id, businessDayId, businessDate, paidAt',
  payments: 'id, orderId, &idempotencyKey, businessDate',
})
db.version(7).stores({
  payments: 'id, orderId, &idempotencyKey, businessDate, reference, status',
})
db.version(8).stores({
  discountLog: 'id, orderId, businessDate, idNumber',
})
db.version(9).stores({
  orders: 'id, businessDayId, businessDate, paidAt, invoiceNo',
  invoicePrints: 'id, orderId',
})
db.version(10).stores({
  queueItems: 'id, orderId, status, station',
  queueEvents: 'id, itemId',
})
db.version(11).stores({
  orders: 'id, businessDayId, businessDate, paidAt, invoiceNo, shiftId',
})
db.version(12).stores({
  approvals: 'id, requesterId, approverId, businessDate, at',
})
db.version(13).stores({
  refunds: 'id, orderId, businessDate, shiftId, &idempotencyKey',
  remakes: 'id, itemId, orderId, businessDate',
  orders: 'id, businessDayId, businessDate, paidAt, invoiceNo, shiftId, &idempotencyKey',
})
db.version(14).stores({
  cashMovements: 'id, shiftId, businessDate, &idempotencyKey',
})
db.version(15).stores({
  promos: 'id, code, active',
  promoUses: 'id, promoId, orderId, businessDate',
})
db.version(16).stores({
  zReports: 'id, &businessDayId, date',
})
db.version(17).stores({
  timeEntries: 'id, userId, businessDate',
})
db.version(18).stores({
  ingredients: 'id, name, active',
})
db.version(19).stores({
  recipes: 'id, refId, [kind+refId]',
})
