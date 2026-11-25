import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db/db'
import { createBranch, createTerminal, createUser } from './db/setup'
import { expectedCash, openBusinessDay, openShift } from './db/shifts'
import { approve } from './db/approvals'
import { payOrder } from './db/orders'
import { refundOrder, voidOrder } from './db/refunds'
import { payPractice } from './db/practice'
import { accountBalance, createCorporateAccount, createStaffAccount, overLimitBy, receiveAccountPayment, setCreditLimit, statement } from './db/accounts'
import { tipReport } from './db/tips'
import { loadReport } from './db/reports'
import { setSetting } from './db/settings'
import { addLine, emptyCart, type Cart, type CartLine } from './lib/cart'
import { invoiceFigures } from './lib/invoice'
import { shareByHours } from './lib/tips'
import { can } from './lib/roles'

let t1 = '', cashier = '', sup = '', trainee = '', shift = '', day = ''
let n = 0
const k = () => `k${++n}`
const line = (id: string, price: number, qty = 1): CartLine => ({ id, itemId: 'i', variantId: 'v', name: 'Latte ' + id, variantLabel: '', basePrice: price, mods: [], notes: [id], allergy: '', qty })
const cartOf = (...ls: CartLine[]): Cart => ls.reduce(addLine, emptyCart())
const cash = (c: number) => [{ method: 'cash' as const, tendered: c }]
const today = () => db.businessDays.get(day).then((d) => d!.date)

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  const b = (await createBranch('Main')).id
  t1 = (await createTerminal(b, 'Counter 1', 'T1')).id
  cashier = (await createUser('Cash', 'cashier', '1111')).id
  sup = (await createUser('Sup', 'supervisor', '2222')).id
  trainee = (await createUser('New', 'trainee', '5555')).id
  day = (await openBusinessDay(b, sup)).id
  shift = (await openShift(t1, cashier, { b1000: 2 })).id
})

describe('training mode', () => {
  it('a practice sale runs the payment rules but writes nothing real: no order, invoice number, stock, ticket, payment or report line', async () => {
    const sale = await payPractice(trainee, cartOf(line('a', 16800)), cash(20000))
    expect(sale).toMatchObject({ total: 16800, change: 3200 })
    expect(await db.practiceSales.count()).toBe(1)
    for (const t of [db.orders, db.payments, db.queueItems, db.stockMoves, db.counters]) expect(await t.count()).toBe(0)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ orders: 0, gross: 0, net: 0 })
    expect(await expectedCash(shift)).toBe(200000)
    // the next real sale still gets invoice number 1
    expect((await payOrder(t1, cashier, cartOf(line('b', 10000)), cash(10000), k())).order.invoiceNo).toBe('T1-000001')
  })
  it('checks the sale like a real one, and is only for trainees (or a supervisor showing how)', async () => {
    await expect(payPractice(trainee, cartOf(line('a', 16800)), cash(10000))).rejects.toThrow(/still to pay/)
    await expect(payPractice(trainee, emptyCart(), [])).rejects.toThrow(/empty/)
    await expect(payPractice(cashier, cartOf(line('a', 100)), cash(100))).rejects.toThrow(/trainees and supervisors/)
    await expect(payPractice(sup, cartOf(line('a', 100)), cash(100))).resolves.toBeTruthy()
    expect(can('trainee', 'sell')).toBe(false) // a trainee cannot ring a real sale at all
  })
})

describe('service charge and tips', () => {
  it('shares are exact: every centavo goes to someone, in proportion to hours', () => {
    const s = shareByHours(10001, new Map([['a', 8], ['b', 4]]))
    expect([...s.values()].reduce((x, y) => x + y, 0)).toBe(10001)
    expect(s.get('a')).toBe(6667) // 2/3 of ₱100.01
    expect(s.get('b')).toBe(3334)
    expect(shareByHours(100, new Map()).size).toBe(0)
  })
  it('a 10% service charge is on what the customer pays (after discount), paid with the order, and never in sales', async () => {
    const cart = { ...cartOf(line('a', 100000)), serviceCharge: true }
    await expect(payOrder(t1, cashier, cart, cash(100000), k())).rejects.toThrow(/still to pay/)
    const { order, change } = await payOrder(t1, cashier, cart, cash(120000), k())
    expect(order).toMatchObject({ gross: 100000, total: 100000, serviceCharge: 10000 })
    expect(change).toBe(10000)
    expect(invoiceFigures(order)).toMatchObject({ service: 10000, tip: 0, due: 100000 })
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ gross: 100000, net: 100000, staffMoney: { serviceCharge: 10000, tips: 0 } })
    expect(r.cash.sales).toBe(110000) // all of it came in
  })
  it('a service charge is not taken on the delivery fee, and a setting changes the rate', async () => {
    await setSetting('serviceChargePct', 5)
    const { order } = await payOrder(t1, cashier, { ...cartOf(line('a', 100000)), serviceCharge: true, deliveryFee: 9000 }, cash(120000), k())
    expect(order.serviceCharge).toBe(5000)
  })
  it('a tip added on top is collected for staff, apart from sales, and must be paid', async () => {
    const cart = { ...cartOf(line('a', 16800)), tip: 5000 }
    await expect(payOrder(t1, cashier, cart, [{ method: 'gcash', amount: 16800, reference: 'R1' }], k())).rejects.toThrow(/still to pay/)
    const { order } = await payOrder(t1, cashier, cart, [{ method: 'gcash', amount: 21800, reference: 'R2' }], k())
    expect(order).toMatchObject({ total: 16800, tip: 5000 })
    expect((await loadReport({ kind: 'shift', shiftId: shift })).staffMoney).toEqual({ tips: 5000, serviceCharge: 0 })
  })
  it('a void returns the tip and service charge with the rest, and net sales stay honest', async () => {
    const { order } = await payOrder(t1, cashier, { ...cartOf(line('a', 10000)), tip: 1000, serviceCharge: true }, cash(12000), k())
    const a = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 10000, ref: order.id })
    await voidOrder({ orderId: order.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: a.id, idempotencyKey: k() })
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r.net).toBe(0)
    expect(r.staffMoney).toEqual({ tips: 0, serviceCharge: 0 }) // a voided order is not a sale, and its tip was handed back
    expect(r.payments.cash.net).toBe(0)
  })
  it('the tip report shares each day’s tips and service charge by hours worked that day', async () => {
    await payOrder(t1, cashier, { ...cartOf(line('a', 10000)), tip: 3000 }, [{ method: 'gcash', amount: 13000, reference: 'R1' }], k())
    await payOrder(t1, cashier, { ...cartOf(line('b', 10000)), serviceCharge: true }, cash(11000), k())
    const date = await today()
    await db.timeEntries.bulkAdd([
      { id: 'e1', userId: cashier, terminalId: t1, inAt: '2026-11-25T00:00:00Z', outAt: '2026-11-25T08:00:00Z', businessDate: date },
      { id: 'e2', userId: sup, terminalId: t1, inAt: '2026-11-25T00:00:00Z', outAt: '2026-11-25T04:00:00Z', businessDate: date },
    ])
    const r = await tipReport(date, date)
    expect(r).toMatchObject({ tips: 3000, service: 1000, unshared: 0 })
    expect(r.people).toEqual([{ userId: cashier, name: 'Cash', amount: 2667 }, { userId: sup, name: 'Sup', amount: 1333 }])
  })
  it('a day with tips but no clock-ins is listed unshared, not lost', async () => {
    await payOrder(t1, cashier, { ...cartOf(line('a', 10000)), tip: 3000 }, [{ method: 'gcash', amount: 13000, reference: 'R1' }], k())
    const date = await today()
    expect(await tipReport(date, date)).toMatchObject({ unshared: 3000, people: [] })
  })
})

describe('charge accounts', () => {
  const charge = (accountId: string, amount: number) => [{ method: 'charge' as const, amount, reference: accountId }]

  it('a company charges a sale: it is a sale and a receivable; the balance and the report show it', async () => {
    const acct = await createCorporateAccount('Acme Corp', 500000, sup)
    const { order, payments } = await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())
    expect(payments[0]).toMatchObject({ method: 'charge', status: 'receivable' })
    expect(await accountBalance(acct.id)).toBe(30000)
    const r = await loadReport({ kind: 'shift', shiftId: shift })
    expect(r).toMatchObject({ net: 30000, accounts: { charged: 30000, received: 0, outstanding: 30000 } })
    expect(r.cash.sales).toBe(0)
    expect(order.invoiceNo).toBe('T1-000001')
  })
  it('over the credit limit needs a supervisor PIN for the part over; within it, none', async () => {
    const acct = await createCorporateAccount('Acme Corp', 50000, sup)
    await payOrder(t1, cashier, cartOf(line('a', 40000)), charge(acct.id, 40000), k())
    expect(await overLimitBy(acct.id, 10000)).toBe(0)
    expect(await overLimitBy(acct.id, 30000)).toBe(20000)
    await expect(payOrder(t1, cashier, cartOf(line('b', 30000)), charge(acct.id, 30000), k())).rejects.toThrow(/supervisor PIN/)
    const a = await approve({ action: 'charge', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 20000, ref: undefined })
    await payOrder(t1, cashier, cartOf(line('b', 30000)), charge(acct.id, 30000), k(), undefined, { charge: a.id })
    expect(await accountBalance(acct.id)).toBe(70000)
    expect((await db.accountTx.toArray()).find((t) => t.approvedBy)?.approvedBy).toBe(sup)
    await setCreditLimit(acct.id, 100000, sup)
    expect(await overLimitBy(acct.id, 30000)).toBe(0)
  })
  it('one account per order; a switched-off account cannot be charged', async () => {
    const a = await createCorporateAccount('A', 500000, sup)
    const b = await createCorporateAccount('B', 500000, sup)
    await expect(payOrder(t1, cashier, cartOf(line('a', 10000)), [...charge(a.id, 5000), ...charge(b.id, 5000)], k())).rejects.toThrow(/one account/)
    await db.accounts.update(a.id, { active: false })
    await expect(payOrder(t1, cashier, cartOf(line('a', 10000)), charge(a.id, 10000), k())).rejects.toThrow(/not active/)
    await expect(createCorporateAccount('b', 1, sup)).rejects.toThrow(/already exists/)
  })
  it('the account pays: cash goes in the drawer, transfers need a reference, and it cannot pay more than it owes', async () => {
    const acct = await createCorporateAccount('Acme Corp', 500000, sup)
    await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())
    const before = await expectedCash(shift)
    await expect(receiveAccountPayment({ accountId: acct.id, amount: 40000, method: 'cash', terminalId: t1, userId: cashier })).rejects.toThrow(/owes only ₱300.00/)
    await expect(receiveAccountPayment({ accountId: acct.id, amount: 10000, method: 'transfer', terminalId: t1, userId: cashier })).rejects.toThrow(/reference/)
    await receiveAccountPayment({ accountId: acct.id, amount: 10000, method: 'cash', terminalId: t1, userId: cashier })
    await receiveAccountPayment({ accountId: acct.id, amount: 5000, method: 'transfer', reference: 'bpi-77', terminalId: t1, userId: cashier })
    expect(await accountBalance(acct.id)).toBe(15000)
    expect(await expectedCash(shift)).toBe(before + 10000) // only the cash is in the drawer
    expect((await loadReport({ kind: 'shift', shiftId: shift })).accounts).toMatchObject({ charged: 30000, received: 15000, outstanding: 15000 })
  })
  it('the monthly statement: opening, each charge with its invoice number, payments, closing', async () => {
    const acct = await createCorporateAccount('Acme Corp', 500000, sup)
    const { order } = await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())
    const date = await today()
    const month = date.slice(0, 7)
    await db.accountTx.add({ id: 'old', accountId: acct.id, kind: 'charge', amount: 50000, at: '2020-01-02T00:00:00Z', by: 'u', businessDate: '2020-01-02' }) // a past month's balance
    await receiveAccountPayment({ accountId: acct.id, amount: 20000, method: 'cash', terminalId: t1, userId: cashier })
    const s = await statement(acct.id, month)
    expect(s).toMatchObject({ opening: 50000, charged: 30000, paid: 20000, closing: 60000 })
    expect(s.lines.map((l) => [l.kind, l.amount, l.invoiceNo])).toEqual([['charge', 30000, order.invoiceNo], ['payment', -20000, undefined]])
    await expect(statement(acct.id, 'nov')).rejects.toThrow(/Month looks like/)
  })
  it('a voided or refunded charged sale gives the credit back to the account', async () => {
    const acct = await createCorporateAccount('Acme Corp', 500000, sup)
    const a1 = (await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())).order
    const v = await approve({ action: 'void', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 30000, ref: a1.id })
    await voidOrder({ orderId: a1.id, terminalId: t1, userId: cashier, reasonCode: 'wrong-order', approvalId: v.id, idempotencyKey: k() })
    expect(await accountBalance(acct.id)).toBe(0)
    const a2 = (await payOrder(t1, cashier, cartOf(line('b', 20000)), charge(acct.id, 20000), k())).order
    await db.queueItems.toCollection().modify({ status: 'served' })
    const r = await approve({ action: 'refund', requesterId: cashier, approverId: sup, pin: '2222', terminalId: t1, amount: 20000, ref: a2.id })
    await refundOrder({ orderId: a2.id, terminalId: t1, userId: cashier, reasonCode: 'quality-complaint', approvalId: r.id, idempotencyKey: k(), picks: { b: 1 }, method: 'charge' })
    expect(await accountBalance(acct.id)).toBe(0)
  })
  it('staff charge: one account per person with a limit from settings; meals over it need a PIN; the statement is what comes off pay', async () => {
    const acct = await createStaffAccount(cashier, sup)
    expect(acct).toMatchObject({ kind: 'staff', name: 'Cash', creditLimit: 50000 })
    await expect(createStaffAccount(cashier, sup)).rejects.toThrow(/already has/)
    await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())
    await expect(payOrder(t1, cashier, cartOf(line('b', 30000)), charge(acct.id, 30000), k())).rejects.toThrow(/supervisor PIN/)
    const s = await statement(acct.id, (await today()).slice(0, 7))
    expect(s.closing).toBe(30000)
  })
  it('a receivable does not block day close', async () => {
    const acct = await createCorporateAccount('Acme Corp', 500000, sup)
    await payOrder(t1, cashier, cartOf(line('a', 30000)), charge(acct.id, 30000), k())
    const { dayCloseChecklist } = await import('./db/shifts')
    await db.shifts.update(shift, { closedAt: 'x' })
    expect((await dayCloseChecklist(day)).ok).toBe(true)
  })
})
