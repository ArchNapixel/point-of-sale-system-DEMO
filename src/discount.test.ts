import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { setSetting } from './db/settings'
import { payOrder } from './db/orders'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import { priceCart, statutoryLine, validateStatutory, type StatutoryInput } from './lib/discount'

const latte = (id: string, qty = 1): CartLine => ({
  id, itemId: 'i', variantId: 'v' + id, name: 'Latte', variantLabel: '16 oz', basePrice: 16800, mods: [], notes: [], allergy: '', qty,
})
const sen = (picks: Record<string, number>, idNumber = 'SC-1'): StatutoryInput => ({ kind: 'senior', name: 'Lola', idNumber, signed: true, picks })

describe('Senior/PWD formula', () => {
  it('₱168 latte → ₱120 at a VAT café, ₱134.40 at a non-VAT café', () => {
    expect(statutoryLine(16800, true)).toEqual({ base: 16800, vatExempt: 15000, discount: 3000, pay: 12000 })
    expect(statutoryLine(16800, false)).toEqual({ base: 16800, vatExempt: 16800, discount: 3360, pay: 13440 })
  })
  it('only the ticked units get it: 1 senior, 3 drinks', () => {
    const cart = { ...addLine(emptyCart(), latte('a', 3)), discount: sen({ a: 1 }) }
    expect(priceCart(cart, true).total).toBe(16800 * 2 + 12000)
    expect(priceCart(cart, true).discount?.reduction).toBe(4800)
  })
  it('a discount whose items were removed is ignored, not applied to the rest', () => {
    const cart = { ...addLine(emptyCart(), latte('a')), discount: sen({ gone: 1 }) }
    expect(priceCart(cart, true)).toMatchObject({ total: 16800, discount: undefined })
  })
  it('needs name, ID number and signature', () => {
    expect(() => validateStatutory({ ...sen({}), name: ' ' })).toThrow(/name/)
    expect(() => validateStatutory({ ...sen({}), idNumber: '' })).toThrow(/ID number/)
    expect(() => validateStatutory({ ...sen({}), signed: false })).toThrow(/sign/)
  })
})

describe('Senior/PWD sale', () => {
  let t1 = ''
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()))
  await db.users.bulkAdd([
    { id: 'u1', name: 'Cash', role: 'cashier', pinHash: '', active: true },
    { id: 'sup1', name: 'Sup', role: 'supervisor', pinHash: '', active: true },
  ])
    const b = await createBranch('Main')
    t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
    await openBusinessDay(b.id, 'sup')
    await openShift(t1, 'u1', { b1000: 2 })
  })
  const cart = (id = 'SC-1') => ({ ...addLine(emptyCart(), latte('a')), discount: sen({ a: 1 }, id) })

  it('charges ₱120, the formula follows the VAT setting, and the log + audit are written', async () => {
    const { order, change } = await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 12000 }], 'k1')
    expect(order).toMatchObject({ gross: 16800, total: 12000 })
    expect(change).toBe(0)
    expect(await db.discountLog.count()).toBe(1)
    expect(await db.auditLog.where('action').equals('discount.statutory').count()).toBe(1)
    await setSetting('vatRegistered', false)
    expect((await payOrder(t1, 'u1', cart('SC-2'), [{ method: 'cash', tendered: 13440 }], 'k2')).order.total).toBe(13440)
  })
  it('paying the undiscounted price leaves the order unpaid', async () => {
    await expect(payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 11999 }], 'k1')).rejects.toThrow(/stays unpaid/)
  })
  it('flags the same ID number used again on the same day, never blocking', async () => {
    const first = await payOrder(t1, 'u1', cart(), [{ method: 'cash', tendered: 12000 }], 'k1')
    const second = await payOrder(t1, 'u1', cart(' sc-1 '), [{ method: 'cash', tendered: 12000 }], 'k2')
    expect((await db.discountLog.where('orderId').equals(first.order.id).first())?.repeatId).toBe(false)
    expect((await db.discountLog.where('orderId').equals(second.order.id).first())?.repeatId).toBe(true)
  })
  it('rejects an unsigned discount at payment', async () => {
    const c = { ...cart(), discount: { ...sen({ a: 1 }), signed: false } }
    await expect(payOrder(t1, 'u1', c, [{ method: 'cash', tendered: 20000 }], 'k1')).rejects.toThrow(/sign/)
    expect(await db.orders.count()).toBe(0)
  })
})
