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
