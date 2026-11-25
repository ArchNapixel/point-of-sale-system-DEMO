import Dexie, { type EntityTable } from 'dexie'
import type { Role } from '../lib/roles'

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
