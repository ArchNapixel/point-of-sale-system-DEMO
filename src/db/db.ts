import Dexie, { type EntityTable, type Table } from 'dexie'
import type { Role } from '../lib/roles'
import type { Cart, CartLine } from '../lib/cart'
import type { QueueStatus, Station } from '../lib/queue'
import type { ApprovalAction } from '../lib/approval'
import type { PayMethod } from '../lib/payments'
import type { AppliedEmployee, AppliedPromo, OrderDiscount } from '../lib/discount'
import type { Promo } from '../lib/promos'
import type { Report } from '../lib/reports'
import type { BaseUnit, IngredientUnit } from '../lib/units'
import type { RecipeLine } from '../lib/recipes'
import type { StockKind } from '../lib/stock'
import type { BillPart } from '../lib/split'

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
  autoSoldOut?: boolean // switched off by the system because an ingredient ran out (switched back on when stock returns)
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
  deliveryFee?: number // a rider fee charged to the customer: paid with the order but never part of sales or discounts
  channelId?: string // keyed in under a delivery app; sold at its prices and paid by the app later (a receivable)
  channelName?: string
  commissionPct?: number // the app's commission when it was sold (a setting per platform, copied here)
  preOrderId?: string
  customerId?: string // a customer who agreed to be saved: loyalty is earned and used against this
  serviceCharge?: number // optional % for big groups: collected for staff, never sales, never discounted
  tip?: number // a tip added on a card or e-wallet: collected for staff, apart from sales
  tabId?: string // paid from a tab: its drinks were sent and its stock taken when each round was added, so paying does neither again
  billId?: string
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
  tabId?: string // made for a tab (orderId is the tab id and orderNumber is 0; the label is the table)
  preOrderId?: string // made ahead for a pre-order (orderId is the pre-order id and orderNumber is 0; the label is the customer)
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
export type Ingredient = {
  id: string
  name: string
  baseUnit: BaseUnit
  units: IngredientUnit[]
  active: boolean
  avgCostMilli?: number // weighted average cost in thousandths of a centavo per base unit (so a fraction of a centavo per ml stays exact). Set by receiving.
  par?: number // wanted on hand, in base units; purchase orders suggest the gap
  cup?: boolean // counts one drink served (the cup): its count variance shows drinks that went out without a sale
}
// One version of a recipe. Saving makes a new version; old ones stay so old sales keep what they used (rule 6).
export type Recipe = { id: string; kind: 'variant' | 'modifier'; refId: string; version: number; lines: RecipeLine[]; at: string; by: string }
// One line of the stock ledger. qty is signed, in the ingredient's base unit: + in, - out. Never edited or deleted (rule 3).
export type StockMove = {
  id: string
  ingredientId: string
  branchId: string
  kind: StockKind
  qty: number
  at: string
  businessDate: string
  userId: string
  ref?: string // the order a sale/void/remake belongs to
  reason?: string // waste reason code
  note?: string
  pairId?: string // links a transfer's two sides, or a production's inputs and output
  recipeVersions?: string[] // the recipe versions a sale used, so old sales keep their cost
  unitCostMilli?: number // what one base unit cost when this moved: a sale keeps its cost even if prices change later (rule 2)
}
export type Supplier = { id: string; name: string; termsDays: number; active: boolean } // termsDays 0 = pay on delivery
// What was ordered. Quantities in base units. Received amounts come from the receipts that point at it.
export type PurchaseOrder = {
  id: string; number: string; supplierId: string; branchId: string; status: 'open' | 'closed'
  lines: { ingredientId: string; qty: number }[]; at: string; by: string
  closedShort?: boolean; closeNote?: string
}
// What arrived, what was turned away, and what the invoice says. Three different numbers (ordered, arrived, paid).
export type Receipt = {
  id: string; poId?: string; supplierId: string; branchId: string; invoiceNo?: string
  arrivedAt: string // when it really came, which may be earlier than when someone counted it
  at: string; by: string
  lines: { ingredientId: string; receivedQty: number; rejectedQty: number; rejectReason?: string; cost: number; unitCostMilli: number }[]
  total: number // centavos on the invoice for what was kept
  needsReview: boolean; reviewedBy?: string // delivery without a PO waits for a supervisor
  dueDate: string // arrival date + the supplier's terms
  paidAt?: string; paidBy?: string; payMethod?: 'cash' | 'transfer'; payRef?: string; cashMovementId?: string
  idempotencyKey: string
}
// A physical count. It is blind: the counter types what they see and expected is worked out afterwards, as of the moment of counting,
// so sales rung up after that time do not distort the variance. Applying it writes one 'count' movement per difference.
export type StockCount = {
  id: string; branchId: string; countedAt: string; at: string; by: string
  lines: { ingredientId: string; counted: number; expected: number; variance: number; avgCostMilli?: number }[]
  status: 'submitted' | 'applied'; appliedAt?: string; appliedBy?: string
  idempotencyKey: string
}
// A table (or a table-tent number for counter orders a runner delivers).
export type CafeTable = { id: string; branchId: string; name: string; seats: number; active: boolean }
// A line on a tab: a cart line plus who added it and in which round. Names stay on the lines when a tab changes hands.
export type TabLine = CartLine & { addedBy: string; round: number; seat?: number; fromTable?: string }
export type TabEvent = { at: string; by: string; kind: 'open' | 'round' | 'move' | 'merge' | 'transfer' | 'bill' | 'paid' | 'walkout' | 'seat'; detail?: Record<string, unknown> }
// An open tab: rounds added through the visit, paid at the end (whole, or split into bills). Never deleted: closed, merged or walkout.
export type Tab = {
  id: string; branchId: string; tableId: string; label: string
  status: 'open' | 'closed' | 'merged' | 'walkout'
  openedAt: string; openedBy: string
  shiftId: string; cashierId: string // who is responsible now: changes at a shift change
  lines: TabLine[]; rounds: number; guests?: number
  settled: Record<string, number> // line id -> centavos already paid by earlier bills
  events: TabEvent[]
  mergedInto?: string
  closedAt?: string; walkout?: { amount: number; reason: string; approvedBy: string; businessDate: string; shiftId: string }
}
// The bill printed for a tab. Adding another round supersedes it: the old one is marked so nobody pays from it.
export type Bill = {
  id: string; tabId: string; version: number; status: 'open' | 'superseded' | 'closed'
  mode: 'item' | 'seat' | 'even' | 'custom' | 'fraction' | 'whole'; parts: BillPart[]; at: string; by: string
}
// A pre-order: a scheduled pickup or delivery, an optional deposit taken now, a prep reminder, the balance at pickup.
export type PreOrder = {
  id: string; branchId: string; customerName: string; phone?: string; kind: 'pickup' | 'delivery'; pickupAt: string
  lines: CartLine[]; deliveryFee?: number; note?: string
  depositPolicy: 'refund' | 'keep' // what happens to the deposit if it is cancelled; saved on the order when it is taken
  status: 'booked' | 'preparing' | 'fulfilled' | 'cancelled'
  createdAt: string; createdBy: string
  prepStartedAt?: string; orderId?: string
  cancelled?: { at: string; by: string; reason: string; note?: string; deposit: 'refunded' | 'kept' | 'none'; wasMade: boolean }
}
// Money taken before the sale: a liability until the order is paid. Not sales, not in the drawer's sales.
export type Deposit = {
  id: string; preOrderId: string; amount: number; method: PayMethod; reference?: string
  shiftId: string; businessDate: string; at: string; by: string
  status: 'held' | 'applied' | 'refunded' | 'forfeited'
  appliedOrderId?: string
  settled?: { at: string; by: string; shiftId: string; approvedBy?: string; method?: PayMethod }
}
// A delivery app. The commission % is a setting per platform. Its prices can differ from the counter's.
export type Channel = { id: string; name: string; commissionPct: number; active: boolean }
export type ChannelPrice = { channelId: string; variantId: string; price: number }
// What a platform paid out against the orders it owed us for. The gap to the expected amount is the commission or a missing order.
export type ChannelPayout = {
  id: string; channelId: string; orderIds: string[]; gross: number; expected: number; received: number; reference?: string; at: string; by: string
}
// The daily check: how many orders the platform tablet shows against how many were keyed into the POS.
export type ChannelCheck = { channelId: string; date: string; platformCount: number; posCount: number; by: string; at: string }
// A customer profile, saved only with consent (Data Privacy Act). Merging keeps all history; "remove my info" anonymizes.
export type Customer = {
  id: string; name: string; phone?: string; consentAt: string; consentBy: string
  createdAt: string; active: boolean; mergedInto?: string; anonymizedAt?: string
}
// Loyalty movements: + earned or corrected up, - redeemed, reversed on a refund or corrected down. The balance is their sum (minus expiry).
export type LoyaltyEntry = {
  id: string; customerId: string; kind: 'earn' | 'redeem' | 'reverse' | 'adjust'; amount: number
  orderId?: string; refundId?: string; at: string; by: string; businessDate: string; note?: string; approvedBy?: string
}
// Money paid now for drinks later: a liability until it is used, never a sale.
export type GiftCard = { id: string; number: string; buyerId?: string; issuedAt: string; issuedBy: string; status: 'active' | 'void'; reissuedAs?: string }
export type GiftCardTx = {
  id: string; cardId: string; kind: 'issue' | 'redeem' | 'refund' | 'reissue-out' | 'reissue-in'; amount: number; balanceAfter: number
  orderId?: string; at: string; by: string
  paid?: { method: PayMethod; reference?: string; shiftId: string } // the purchase: how it was paid and in whose drawer
}
// A charge account: a company that orders on credit and pays monthly, or a staff member whose meals come off their pay.
export type Account = { id: string; kind: 'corporate' | 'staff'; name: string; creditLimit: number; userId?: string; note?: string; active: boolean }
// Movements on an account. + means they owe us more, - means they owe less. The balance is the sum.
export type AccountTx = {
  id: string; accountId: string; kind: 'charge' | 'payment' | 'refund'; amount: number; orderId?: string
  at: string; by: string; businessDate: string; method?: PayMethod; reference?: string; shiftId?: string; approvedBy?: string
}
// A sale rung up in training mode: no invoice number, no stock, no money, never in any report.
export type PracticeSale = { id: string; userId: string; at: string; lines: CartLine[]; total: number; payments: { method: PayMethod; amount: number }[]; change: number }
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
  status: 'verified' | 'pending' | 'receivable' // e-wallet payments stay pending until a supervisor sees them in the merchant app; receivable = a delivery app owes it
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
  stockMoves: EntityTable<StockMove, 'id'>
  suppliers: EntityTable<Supplier, 'id'>
  stockCounts: EntityTable<StockCount, 'id'>
  cafeTables: EntityTable<CafeTable, 'id'>
  tabs: EntityTable<Tab, 'id'>
  preOrders: EntityTable<PreOrder, 'id'>
  deposits: EntityTable<Deposit, 'id'>
  channels: EntityTable<Channel, 'id'>
  customers: EntityTable<Customer, 'id'>
  loyaltyLedger: EntityTable<LoyaltyEntry, 'id'>
  giftCards: EntityTable<GiftCard, 'id'>
  giftCardTx: EntityTable<GiftCardTx, 'id'>
  accounts: EntityTable<Account, 'id'>
  accountTx: EntityTable<AccountTx, 'id'>
  practiceSales: EntityTable<PracticeSale, 'id'>
  channelPrices: Table<ChannelPrice, [string, string]>
  channelPayouts: EntityTable<ChannelPayout, 'id'>
  channelChecks: Table<ChannelCheck, [string, string]>
  bills: EntityTable<Bill, 'id'>
  purchaseOrders: EntityTable<PurchaseOrder, 'id'>
  receipts: EntityTable<Receipt, 'id'>
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
db.version(20).stores({
  stockMoves: 'id, ingredientId, ref, businessDate, [ingredientId+branchId]',
})
db.version(21).stores({
  suppliers: 'id, name',
  purchaseOrders: 'id, supplierId, status',
  receipts: 'id, poId, supplierId, dueDate, &idempotencyKey',
})
db.version(22).stores({
  stockCounts: 'id, branchId, countedAt, &idempotencyKey',
})
db.version(23).stores({
  cafeTables: 'id, branchId',
  tabs: 'id, branchId, status, tableId',
  bills: 'id, tabId',
})
db.version(24).stores({
  preOrders: 'id, branchId, pickupAt, status',
  deposits: 'id, preOrderId, status, shiftId',
  channels: 'id, name',
  channelPrices: '[channelId+variantId], channelId',
  channelPayouts: 'id, channelId',
  channelChecks: '[channelId+date]',
})
db.version(25).stores({
  customers: 'id, name, phone',
  loyaltyLedger: 'id, customerId, orderId, at',
  giftCards: 'id, &number',
  giftCardTx: 'id, cardId, orderId',
})
db.version(26).stores({
  accounts: 'id, name',
  accountTx: 'id, accountId, orderId, businessDate',
  practiceSales: 'id, userId, at',
})
