import Dexie, { type EntityTable } from 'dexie'
import type { Role } from '../lib/roles'
import type { Cart } from '../lib/cart'
import type { PayMethod } from '../lib/payments'
import type { OrderDiscount } from '../lib/discount'

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
export type Category = { id: string; name: string; sort: number; active: boolean }
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
  status: 'paid'
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
export type InvoicePrint = { id: string; orderId: string; userId: string; at: string; kind: 'original' | 'reprint' }
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
}
export type CashCount = {
  id: string
  shiftId: string
  kind: 'open' | 'close'
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
