import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { formatPeso, pct, pesos } from './lib/money'
import { newId } from './lib/id'
import { can } from './lib/roles'
import { businessDate } from './db/businessDate'
import { audit } from './db/audit'
import { db } from './db/db'

describe('core', () => {
  it('money stays integer centavos', () => {
    expect(pesos(168)).toBe(16800)
    expect(formatPeso(13440)).toBe('₱134.40')
    expect(pct(15000, 20)).toBe(3000) // senior latte: 168/1.12=150, 20% off = 30 → pays 120
    expect(pct(15700, 20)).toBe(3140)
  })
  it('ids are unique uuids', () => {
    expect(newId()).not.toBe(newId())
  })
  it('roles: cashier cannot refund, supervisor can', () => {
    expect(can('cashier', 'refund')).toBe(false)
    expect(can('supervisor', 'refund')).toBe(true)
  })
  it('1 AM belongs to the previous business date with a 4 AM cutoff', () => {
    expect(businessDate(new Date(2026, 10, 26, 1, 0), 4)).toBe('2026-11-25')
    expect(businessDate(new Date(2026, 10, 26, 5, 0), 4)).toBe('2026-11-26')
  })
  it('audit writes a log row and queues it for sync', async () => {
    const e = await audit({ userId: 'u1', action: 'test' })
    expect(await db.auditLog.get(e.id)).toBeTruthy()
    expect(await db.outbox.where('recordId').equals(e.id).count()).toBe(1)
  })
})
