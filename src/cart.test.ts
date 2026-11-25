import { describe, expect, it } from 'vitest'
import {
  MAX_QTY, addLine, buildLine, cartCount, cartTotal, changeQty, duplicateLine, emptyCart, lineTotal, removeLine, replaceLine,
  type CartLine,
} from './lib/cart'
import { quote, type GroupWithMods } from './lib/modifierPricing'

const milk: GroupWithMods = {
  id: 'g1', name: 'Milk', min: 1, max: 1, sort: 0, active: true,
  modifiers: [
    { id: 'dairy', groupId: 'g1', name: 'Dairy', price: 0, sizePrices: {}, freeQty: 0, maxQty: 1, soldOut: false, sort: 0, active: true },
    { id: 'oat', groupId: 'g1', name: 'Oat', price: 3000, sizePrices: { '16 oz': 4000 }, freeQty: 0, maxQty: 1, soldOut: false, sort: 1, active: true },
  ],
}
const latte = { id: 'i1', name: 'Latte' }
const v16 = { id: 'v16', size: '16 oz', price: 14000 }

const line = (id: string, pick: string, notes: string[] = [], allergy = ''): CartLine => {
  const q = quote(v16, [milk], [{ modifierId: pick, qty: 1 }])
  return buildLine(id, latte, v16, '16 oz · Iced', q, notes, allergy)
}

describe('cart', () => {
  it('copies the price and add-ons onto the line', () => {
    const l = line('a', 'oat')
    expect(l.basePrice).toBe(14000)
    expect(l.mods).toEqual([{ modifierId: 'oat', name: 'Oat', qty: 1, unit: 4000, charge: 4000 }])
    expect(lineTotal(l)).toBe(18000)
  })
  it('adding the same drink again raises the quantity; a different one is its own line', () => {
    let c = addLine(emptyCart(), line('a', 'oat'))
    c = addLine(c, line('b', 'oat'))
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0].qty).toBe(2)
    c = addLine(c, line('c', 'dairy'))
    c = addLine(c, line('d', 'oat', ['Less ice']))
    expect(c.lines).toHaveLength(3)
    expect(cartCount(c)).toBe(4)
    expect(cartTotal(c)).toBe(18000 * 2 + 14000 + 18000)
  })
  it('allergy text is part of the drink: it never merges into a plain one', () => {
    let c = addLine(emptyCart(), line('a', 'dairy'))
    c = addLine(c, line('b', 'dairy', [], 'Nut allergy'))
    expect(c.lines).toHaveLength(2)
  })
  it('minus lowers the quantity and removes the line at zero; quantity is capped', () => {
    let c = addLine(emptyCart(), line('a', 'dairy'))
    c = changeQty(c, 'a', 1)
    expect(c.lines[0].qty).toBe(2)
    c = changeQty(c, 'a', -1)
    c = changeQty(c, 'a', -1)
    expect(c.lines).toEqual([])
    c = addLine(emptyCart(), line('a', 'dairy'))
    expect(changeQty(c, 'a', 500).lines[0].qty).toBe(MAX_QTY)
  })
  it('duplicate makes a separate line of 1 right below, which can then be edited', () => {
    let c = addLine(emptyCart(), line('a', 'dairy'))
    c = addLine(c, line('z', 'oat'))
    c = changeQty(c, 'a', 2)
    c = duplicateLine(c, 'a', 'a2')
    expect(c.lines.map((l) => [l.id, l.qty])).toEqual([['a', 3], ['a2', 1], ['z', 1]])
    c = replaceLine(c, 'a2', line('ignored', 'oat', ['Extra hot']))
    expect(c.lines[1]).toMatchObject({ id: 'a2', qty: 1, notes: ['Extra hot'] })
    expect(c.lines[1].mods[0].modifierId).toBe('oat')
    expect(c.lines).toHaveLength(3)
  })
  it('removes a line', () => {
    const c = removeLine(addLine(emptyCart(), line('a', 'dairy')), 'a')
    expect(c.lines).toEqual([])
  })
})
