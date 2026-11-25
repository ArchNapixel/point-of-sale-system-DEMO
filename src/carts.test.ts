import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { discardHeld, holdCart, listHeld, resumeHeld } from './db/carts'
import { nextOrderNumber } from './db/orders'
import { addLine, emptyCart, type CartLine } from './lib/cart'

beforeEach(() => Promise.all(db.tables.map((t) => t.clear())))

const line: CartLine = {
  id: 'l1', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '16 oz', basePrice: 14000, mods: [], notes: [], allergy: '', qty: 2,
}
const cartWithLatte = () => ({ ...addLine(emptyCart(), line), name: 'Mark' })

describe('held carts', () => {
  it('cannot hold an empty cart', async () => {
    await expect(holdCart('t1', 's1', 'u', emptyCart())).rejects.toThrow(/empty/)
  })
  it('holds by name, then resumes with the cart exactly as it was', async () => {
    const h = await holdCart('t1', 's1', 'u', cartWithLatte())
    expect(h.label).toBe('Mark')
    expect((await listHeld('t1')).map((x) => x.id)).toEqual([h.id])
    expect(await listHeld('t2')).toEqual([])
    const cart = await resumeHeld(h.id)
    expect(cart.lines[0].qty).toBe(2)
    expect(await listHeld('t1')).toEqual([])
    expect((await db.heldCarts.get(h.id))?.status).toBe('resumed') // kept as history
    await expect(resumeHeld(h.id)).rejects.toThrow(/no longer held/)
  })
  it('falls back to the table, then the time, for the label', async () => {
    const withTable = { ...cartWithLatte(), name: '', table: '4' }
    expect((await holdCart('t1', 's1', 'u', withTable)).label).toBe('Table 4')
    expect((await holdCart('t1', 's1', 'u', { ...cartWithLatte(), name: '' })).label).toMatch(/^Held /)
  })
  it('a discarded cart is kept, not deleted', async () => {
    const h = await holdCart('t1', 's1', 'u', cartWithLatte())
    await discardHeld(h.id)
    expect(await listHeld('t1')).toEqual([])
    expect(await db.heldCarts.count()).toBe(1)
  })
})

describe('order numbers', () => {
  it('count up per business day and never repeat', async () => {
    expect(await nextOrderNumber('dayA')).toBe(1)
    expect(await nextOrderNumber('dayA')).toBe(2)
    expect(await nextOrderNumber('dayB')).toBe(1)
    const many = await Promise.all([nextOrderNumber('dayA'), nextOrderNumber('dayA'), nextOrderNumber('dayA')])
    expect(new Set(many).size).toBe(3)
  })
})
