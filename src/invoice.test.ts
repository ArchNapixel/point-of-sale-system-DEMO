import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal } from './db/setup'
import { openBusinessDay, openShift } from './db/shifts'
import { setSetting } from './db/settings'
import { logPrint, payOrder } from './db/orders'
import { addLine, emptyCart, type CartLine } from './lib/cart'
import { formatInvoiceNo, invoiceFigures, matchesOrder } from './lib/invoice'

const latte = (qty = 1, price = 16800): CartLine => ({
  id: 'a', itemId: 'i', variantId: 'v', name: 'Latte', variantLabel: '16 oz', basePrice: price, mods: [], notes: [], allergy: '', qty,
})
const cart = (price?: number) => ({ ...addLine(emptyCart(), latte(1, price)), name: 'Mark' })
const cash = (n: number) => [{ method: 'cash' as const, tendered: n }]

let t1 = '', t2 = ''
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  await db.users.bulkAdd([
    { id: 'u1', name: 'Cash', role: 'cashier', pinHash: '', active: true },
    { id: 'sup1', name: 'Sup', role: 'supervisor', pinHash: '', active: true },
  ])
  const b = await createBranch('Main')
  t1 = (await createTerminal(b.id, 'Counter 1', 'T1')).id
  t2 = (await createTerminal(b.id, 'Counter 2', 'T2')).id
  await openBusinessDay(b.id, 'sup')
  await openShift(t1, 'u1', { b1000: 2 })
  await openShift(t2, 'u2', { b1000: 2 })
})

describe('invoice numbers', () => {
  it('formats as T1-000123', () => expect(formatInvoiceNo('T1', 123)).toBe('T1-000123'))
  it('run 1, 2, 3 per terminal, independently', async () => {
    const a = await payOrder(t1, 'u1', cart(), cash(16800), 'k1')
    const b = await payOrder(t1, 'u1', cart(), cash(16800), 'k2')
    const c = await payOrder(t2, 'u2', cart(), cash(16800), 'k3')
    expect([a.order.invoiceNo, b.order.invoiceNo, c.order.invoiceNo]).toEqual(['T1-000001', 'T1-000002', 'T2-000001'])
  })
  it('a failed sale does not use up a number, and a retry does not issue a second one', async () => {
    await expect(payOrder(t1, 'u1', cart(), cash(100), 'k1')).rejects.toThrow()
    const a = await payOrder(t1, 'u1', cart(), cash(16800), 'k2')
    const again = await payOrder(t1, 'u1', cart(), cash(16800), 'k2')
    expect(a.order.invoiceNo).toBe('T1-000001')
    expect(again.order.id).toBe(a.order.id)
    expect((await payOrder(t1, 'u1', cart(), cash(16800), 'k3')).order.invoiceNo).toBe('T1-000002')
  })
})

describe('invoice figures', () => {
  it('VAT café: ₱112 sale → VATable ₱100 + VAT ₱12', async () => {
    const { order } = await payOrder(t1, 'u1', cart(11200), cash(11200), 'k1')
    expect(invoiceFigures(order)).toEqual({ vatRegistered: true, vatable: 10000, vat: 1200, vatExempt: 0, discount: 0, other: 0, fee: 0, due: 11200 })
  })
  it('senior latte: VAT-exempt ₱150, discount ₱30, due ₱120 — adds up', async () => {
    const c = { ...cart(), discount: { kind: 'senior' as const, name: 'Lola', idNumber: 'SC1', signed: true, picks: { a: 1 } } }
    const f = invoiceFigures((await payOrder(t1, 'u1', c, cash(12000), 'k1')).order)
    expect(f).toMatchObject({ vatable: 0, vat: 0, vatExempt: 15000, discount: 3000, due: 12000 })
    if (f.vatRegistered) expect(f.vatable + f.vat + f.vatExempt - f.discount).toBe(f.due)
  })
  it('mixed cart: senior drink plus a normal drink still adds up', async () => {
    const c = { ...addLine(cart(), { ...latte(), id: 'b', variantId: 'v2' }), discount: { kind: 'senior' as const, name: 'L', idNumber: 'S', signed: true, picks: { a: 1 } } }
    const f = invoiceFigures((await payOrder(t1, 'u1', c, cash(30000), 'k1')).order)
    if (f.vatRegistered) expect(f.vatable + f.vat + f.vatExempt - f.discount).toBe(f.due)
  })
  it('non-VAT café has no VAT lines, and keeps the setting it was sold under', async () => {
    await setSetting('vatRegistered', false)
    const { order } = await payOrder(t1, 'u1', cart(), cash(16800), 'k1')
    await setSetting('vatRegistered', true)
    expect(invoiceFigures(order)).toEqual({ vatRegistered: false, sales: 16800, discount: 0, other: 0, fee: 0, due: 16800 })
  })
  it('stores the buyer name and TIN only when given', async () => {
    expect((await payOrder(t1, 'u1', cart(), cash(16800), 'k1')).order.buyer).toBeUndefined()
    expect((await payOrder(t1, 'u1', cart(), cash(16800), 'k2', { name: 'ACME', tin: '123' })).order.buyer).toEqual({ name: 'ACME', tin: '123' })
  })
})

describe('reprints and search', () => {
  it('the first print is the original, later ones are REPRINTs and audited', async () => {
    const { order } = await payOrder(t1, 'u1', cart(), cash(16800), 'k1')
    expect(await logPrint(order.id, 'sup1')).toBe('original')
    expect(await logPrint(order.id, 'sup1')).toBe('reprint')
    expect(await db.invoicePrints.count()).toBe(2)
    expect(await db.auditLog.where('action').equals('invoice.reprint').count()).toBe(1)
  })
  it('finds past sales by invoice number, order number or name', async () => {
    const { order } = await payOrder(t1, 'u1', cart(), cash(16800), 'k1')
    expect(['t1-000001', '#1', 'mark', ''].every((q) => matchesOrder(order, q))).toBe(true)
    expect(matchesOrder(order, 'T2-')).toBe(false)
  })
})
