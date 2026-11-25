import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { setSetting } from './db/settings'
import {
  closeBusinessDay, countTotal, expectedFloat, getOpenShift, getSellContext, lateCloseShift, openBusinessDay, openShift,
} from './db/shifts'

let branchId = ''
let t1 = ''
const FLOAT_2000 = { b1000: 2 } // 2 × ₱1,000

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  branchId = (await createBranch('Main')).id
  t1 = (await createTerminal(branchId, 'Counter 1', 'T1')).id
})

describe('shifts', () => {
  it('counts by denomination, keeping ₱20 bill and coin apart', () => {
    expect(countTotal({ b1000: 1, b20: 2, c20: 1, c5: 3, c025: 4 })).toBe(100000 + 4000 + 2000 + 1500 + 100)
    expect(countTotal({})).toBe(0)
  })
  it('no shift without an open day, and no selling', async () => {
    await expect(openShift(t1, 'u1', FLOAT_2000)).rejects.toThrow(/open the business day/)
    expect(await getSellContext(t1)).toBeNull()
  })
  it('opens a day once per branch', async () => {
    await openBusinessDay(branchId, 'sup')
    await expect(openBusinessDay(branchId, 'sup')).rejects.toThrow(/already has an open/)
  })
  it('opening a shift matching the float has no gap; the day and shift allow selling', async () => {
    await openBusinessDay(branchId, 'sup')
    const s = await openShift(t1, 'u1', FLOAT_2000)
    expect(s.floatGap).toBe(0)
    expect((await getSellContext(t1))?.shift.id).toBe(s.id)
    expect(await db.cashCounts.where('shiftId').equals(s.id).count()).toBe(1)
  })
  it('flags a ₱150 gap against what the closer left, and still opens', async () => {
    await openBusinessDay(branchId, 'sup')
    const first = await openShift(t1, 'u1', FLOAT_2000)
    await db.shifts.update(first.id, { closedAt: 'x', leftInDrawer: 200000 }) // normal close arrives in 1K
    expect((await expectedFloat(t1)).source).toBe('last-close')
    const s = await openShift(t1, 'u2', { b1000: 1, b500: 1, b200: 1, c20: 0, b100: 1, b50: 1 }) // ₱1,850
    expect(s.expectedFloat).toBe(200000)
    expect(s.floatGap).toBe(-15000)
  })
  it('expected float falls back to the setting when the last close was a late close', async () => {
    await setSetting('floatCentavos', 150000)
    await openBusinessDay(branchId, 'sup')
    const s = await openShift(t1, 'u1', FLOAT_2000)
    await lateCloseShift(s.id, 'sup', 'tablet died')
    expect(await expectedFloat(t1)).toEqual({ amount: 150000, source: 'setting' })
  })
  it('an unclosed shift blocks the next one until a supervisor late-closes it', async () => {
    await openBusinessDay(branchId, 'sup')
    const s = await openShift(t1, 'u1', FLOAT_2000)
    await expect(openShift(t1, 'u2', FLOAT_2000)).rejects.toThrow(/supervisor must close/)
    await expect(openShift(t1, 'u1', FLOAT_2000)).rejects.toThrow(/already have a shift/)
    await expect(lateCloseShift(s.id, 'sup', ' ')).rejects.toThrow(/reason/)
    await lateCloseShift(s.id, 'sup', 'forgot to close')
    const closed = await db.shifts.get(s.id)
    expect(closed?.lateClose).toBe(true)
    expect(await getOpenShift(t1)).toBeUndefined()
    await openShift(t1, 'u2', FLOAT_2000)
  })
  it('two terminals have independent drawers', async () => {
    const t2 = (await createTerminal(branchId, 'Counter 2', 'T2')).id
    await openBusinessDay(branchId, 'sup')
    await openShift(t1, 'u1', FLOAT_2000)
    await openShift(t2, 'u2', FLOAT_2000)
    expect((await getOpenShift(t2))?.cashierId).toBe('u2')
  })
  it('the day cannot close while a shift is open', async () => {
    const day = await openBusinessDay(branchId, 'sup')
    const s = await openShift(t1, 'u1', FLOAT_2000)
    await expect(closeBusinessDay(day.id, 'sup')).rejects.toThrow(/Close the open shift/)
    await lateCloseShift(s.id, 'sup', 'end of day')
    await closeBusinessDay(day.id, 'sup')
    expect(await getSellContext(t1)).toBeNull()
  })
  it('every step is audited', async () => {
    await openBusinessDay(branchId, 'sup')
    await openShift(t1, 'u1', FLOAT_2000)
    const actions = (await db.auditLog.toArray()).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['day.open', 'shift.open']))
  })
})
