import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser, updateUser } from './db/setup'
import { verifyLogin } from './db/users'
import { clockIn, clockOut, entriesBetween, fixEntry, openEntry } from './db/timeclock'
import { entryHours, hoursCsv, isLong } from './lib/timeclock'

let t1 = '', ana = '', sup = '', owner = ''
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  t1 = (await createTerminal((await createBranch('Main')).id, 'Counter 1', 'T1')).id
  ana = (await createUser('Ana', 'barista', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  owner = (await createUser('Boss', 'owner', '3333')).id
})

describe('clock in and out', () => {
  it('clocks in on a store terminal once, then out; each is logged', async () => {
    const e = await clockIn(ana, t1)
    expect(e.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await expect(clockIn(ana, t1)).rejects.toThrow(/already clocked in/)
    expect((await openEntry(ana))?.id).toBe(e.id)
    expect((await clockOut(ana)).outAt).toBeTruthy()
    await expect(clockOut(ana)).rejects.toThrow(/not clocked in/)
    expect(await db.auditLog.where('action').anyOf('clock.in', 'clock.out').count()).toBe(2)
  })
  it('refuses a clock-in that is not on a store terminal', async () => {
    await expect(clockIn(ana, 'nowhere')).rejects.toThrow(/store terminal/)
    await db.terminals.update(t1, { active: false })
    await expect(clockIn(ana, t1)).rejects.toThrow(/store terminal/)
  })
  it('hours are worked out to 2 decimals; an open entry has none yet', () => {
    expect(entryHours({ inAt: '2026-11-25T08:00:00Z', outAt: '2026-11-25T16:30:00Z' })).toBe(8.5)
    expect(entryHours({ inAt: '2026-11-25T08:00:00Z' })).toBe(0)
  })
})

describe('long shifts and fixes', () => {
  it('flags an entry running past the limit, open or closed', () => {
    const now = new Date()
    expect(isLong({ inAt: ago(19) }, now, 12)).toBe(true) // forgot to clock out: 19 hours
    expect(isLong({ inAt: ago(8) }, now, 12)).toBe(false)
    expect(isLong({ inAt: ago(30), outAt: ago(10) }, now, 12)).toBe(true)
  })
  it('a supervisor fixes the time with a reason; the original is kept and it is logged', async () => {
    await db.timeEntries.add({ id: 'e1', userId: ana, terminalId: t1, inAt: ago(19), businessDate: '2026-11-25' })
    await expect(fixEntry('e1', { inAt: ago(19), outAt: ago(11) }, ' ', sup)).rejects.toThrow(/reason/)
    await expect(fixEntry('e1', { inAt: ago(19), outAt: ago(20) }, 'x', sup)).rejects.toThrow(/after clock-in/)
    await expect(fixEntry('e1', { inAt: ago(19), outAt: new Date(Date.now() + 3_600_000).toISOString() }, 'x', sup)).rejects.toThrow(/future/)
    const out = ago(11)
    await fixEntry('e1', { inAt: ago(19), outAt: out }, 'Forgot to clock out', sup)
    const e = (await db.timeEntries.get('e1'))!
    expect(e.outAt).toBe(out)
    expect(e.edits).toMatchObject([{ by: sup, reason: 'Forgot to clock out', was: { outAt: undefined } }])
    expect(await db.auditLog.where('action').equals('clock.fix').count()).toBe(1)
  })
  it('nobody fixes their own hours', async () => {
    await db.timeEntries.add({ id: 'e2', userId: sup, terminalId: t1, inAt: ago(10), businessDate: '2026-11-25' })
    await expect(fixEntry('e2', { inAt: ago(10), outAt: ago(2) }, 'x', sup)).rejects.toThrow(/another supervisor/)
  })
})

describe('hours export', () => {
  it('one row per entry and a total per person, with flags', async () => {
    await db.timeEntries.bulkAdd([
      { id: 'a', userId: ana, terminalId: t1, inAt: '2026-11-24T00:00:00Z', outAt: '2026-11-24T08:00:00Z', businessDate: '2026-11-24' },
      { id: 'b', userId: ana, terminalId: t1, inAt: '2026-11-25T00:00:00Z', outAt: '2026-11-25T04:30:00Z', businessDate: '2026-11-25', edits: [{ at: 'x', by: sup, reason: 'r', was: { inAt: 'x' } }] },
      { id: 'c', userId: sup, terminalId: t1, inAt: '2026-11-25T01:00:00Z', businessDate: '2026-11-25' },
    ])
    const names = new Map([[ana, 'Ana'], [sup, 'Sup, the "boss"']])
    const csv = hoursCsv(await entriesBetween('2026-11-24', '2026-11-25'), names, new Date('2026-11-25T02:00:00Z'), 12).split('\n')
    expect(csv[0]).toBe('Name,Business date,Clock in,Clock out,Hours,Flag')
    expect(csv).toContain('Ana,2026-11-24,2026-11-24T00:00:00Z,2026-11-24T08:00:00Z,8,')
    expect(csv).toContain('Ana,2026-11-25,2026-11-25T00:00:00Z,2026-11-25T04:30:00Z,4.5,time fixed')
    expect(csv).toContain('Ana,,,TOTAL,12.5,')
    expect(csv.some((l) => l.startsWith('"Sup, the ""boss""",2026-11-25') && l.endsWith('still clocked in'))).toBe(true)
  })
})

describe('PIN reset by the owner', () => {
  it('works at once: the old PIN stops, the new one signs in, and the reset is logged', async () => {
    expect(await verifyLogin(sup, '2222')).not.toBeNull()
    await updateUser(sup, { name: 'Sup', role: 'supervisor', pin: '9999' }, owner)
    expect(await verifyLogin(sup, '2222')).toBeNull()
    expect(await verifyLogin(sup, '9999')).not.toBeNull()
    expect(await db.auditLog.where('action').equals('user.pinReset').toArray()).toMatchObject([{ userId: owner, ref: sup }])
  })
  it('changing only the name does not log a reset', async () => {
    await updateUser(ana, { name: 'Ana B', role: 'barista' }, owner)
    expect(await db.auditLog.where('action').equals('user.pinReset').count()).toBe(0)
  })
})
