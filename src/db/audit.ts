import { db, type AuditEntry } from './db'
import { newId } from '../lib/id'
import { businessDate } from './businessDate'
import { getSetting } from './settings'

/** Write an audit entry for anything touching money or stock (design rule 8). Append-only. */
export async function audit(
  e: Pick<AuditEntry, 'userId' | 'action'> & Partial<Pick<AuditEntry, 'approverId' | 'ref' | 'detail'>>,
) {
  const now = new Date()
  const entry: AuditEntry = {
    ...e,
    id: newId(),
    at: now.toISOString(),
    businessDate: businessDate(now, await getSetting('dayCutoffHour')),
  }
  await db.auditLog.add(entry)
  await db.outbox.add({ id: newId(), table: 'auditLog', recordId: entry.id, at: entry.at, synced: 0 })
  return entry
}
