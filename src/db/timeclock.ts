import { db, type TimeEntry } from './db'
import { newId } from '../lib/id'
import { audit } from './audit'
import { businessDate } from './businessDate'
import { getSetting } from './settings'

/** Clock in. Only on one of the store's terminals (so a friend cannot clock you in from home). One open entry per person. */
export async function clockIn(userId: string, terminalId: string): Promise<TimeEntry> {
  const terminal = await db.terminals.get(terminalId)
  if (!terminal?.active) throw new Error('Clock in on one of the store terminals')
  const user = await db.users.get(userId)
  if (!user?.active) throw new Error('Unknown staff member')
  return db.transaction('rw', db.timeEntries, db.settings, db.auditLog, db.outbox, async () => {
    if (await openEntry(userId)) throw new Error('You are already clocked in')
    const now = new Date()
    const e: TimeEntry = { id: newId(), userId, terminalId, inAt: now.toISOString(), businessDate: businessDate(now, await getSetting('dayCutoffHour')) }
    await db.timeEntries.add(e)
    await db.outbox.add({ id: newId(), table: 'timeEntries', recordId: e.id, at: e.inAt, synced: 0 })
    await audit({ userId, action: 'clock.in', ref: e.id, detail: { terminalId } })
    return e
  })
}

export async function clockOut(userId: string): Promise<TimeEntry> {
  return db.transaction('rw', db.timeEntries, db.settings, db.auditLog, db.outbox, async () => {
    const e = await openEntry(userId)
    if (!e) throw new Error('You are not clocked in')
    const outAt = new Date().toISOString()
    await db.timeEntries.update(e.id, { outAt })
    await audit({ userId, action: 'clock.out', ref: e.id })
    return { ...e, outAt }
  })
}

export const openEntry = async (userId: string) => (await db.timeEntries.where('userId').equals(userId).toArray()).find((e) => !e.outAt)

export const entriesBetween = async (fromDate: string, toDate: string) =>
  (await db.timeEntries.where('businessDate').between(fromDate, toDate, true, true).toArray()).sort((a, b) => a.inAt.localeCompare(b.inAt))

/**
 * A supervisor fixes a wrong time (forgot to clock out: 19 hours). A reason is required, and the original times are kept
 * in the entry's edit history. Nobody can fix their own hours, and times cannot be in the future.
 */
export async function fixEntry(entryId: string, fix: { inAt: string; outAt: string }, reason: string, supervisorId: string) {
  if (!reason.trim()) throw new Error('A reason is required')
  const inMs = Date.parse(fix.inAt)
  const outMs = Date.parse(fix.outAt)
  if (Number.isNaN(inMs) || Number.isNaN(outMs)) throw new Error('Enter both times')
  if (outMs <= inMs) throw new Error('Clock-out must be after clock-in')
  if (outMs > Date.now() + 60_000) throw new Error('Times cannot be in the future')
  const e = await db.timeEntries.get(entryId)
  if (!e) throw new Error('Entry not found')
  if (e.userId === supervisorId) throw new Error('Ask another supervisor to fix your own hours')
  const edits = [...(e.edits ?? []), { at: new Date().toISOString(), by: supervisorId, reason: reason.trim(), was: { inAt: e.inAt, outAt: e.outAt } }]
  await db.timeEntries.update(entryId, { inAt: fix.inAt, outAt: fix.outAt, edits })
  await audit({ userId: supervisorId, action: 'clock.fix', ref: entryId, detail: { reason: reason.trim(), was: { inAt: e.inAt, outAt: e.outAt }, now: fix } })
}
