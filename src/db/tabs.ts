import { db, type Bill, type CafeTable, type Order, type Tab, type TabLine } from './db'
import { newId } from '../lib/id'
import { lineTotal, type Cart } from '../lib/cart'
import { checkReason } from '../lib/reasons'
import { dues, partsByLines, partsCustom, partsEven, type BillPart } from '../lib/split'
import { audit } from './audit'
import { consumeApproval } from './approvals'
import { createQueueItems } from './queue'
import { alertAfterSale, deductSale, syncModifierAvailability } from './stock'
import { getSellContext } from './shifts'
import { businessDate } from './businessDate'
import { getSetting } from './settings'

const ev = (by: string, kind: Tab['events'][number]['kind'], detail?: Record<string, unknown>) => ({ at: new Date().toISOString(), by, kind, ...(detail && { detail }) })

/** What the tab comes to, and how much of it is still unpaid. */
export const tabTotals = (t: Pick<Tab, 'lines' | 'settled'>) => ({
  total: t.lines.reduce((s, l) => s + lineTotal(l), 0),
  due: dues(t.lines, t.settled).reduce((s, d) => s + d.due, 0),
})

// ---- tables ----
export async function createTable(branchId: string, name: string, seats: number, userId: string): Promise<CafeTable> {
  const n = name.trim()
  if (!n) throw new Error('Table name is required')
  if (!(await db.branches.get(branchId))) throw new Error('Pick a branch')
  if (!Number.isInteger(seats) || seats < 1 || seats > 100) throw new Error('Seats must be 1 to 100')
  if ((await db.cafeTables.where('branchId').equals(branchId).toArray()).some((t) => t.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists here`)
  const t: CafeTable = { id: newId(), branchId, name: n, seats, active: true }
  await db.cafeTables.add(t)
  await audit({ userId, action: 'table.create', ref: t.id, detail: { name: n, seats } })
  return t
}

export async function setTableActive(id: string, active: boolean, userId: string) {
  if (!active && (await openTabOn(id))) throw new Error('This table has an open tab')
  await db.cafeTables.update(id, { active })
  await audit({ userId, action: active ? 'table.restore' : 'table.archive', ref: id })
}

export const openTabOn = async (tableId: string) => (await db.tabs.where('tableId').equals(tableId).toArray()).find((t) => t.status === 'open')

// ---- rounds ----
/**
 * Adds what the table ordered as a round on its tab (opening the tab if the table has none). The drinks go to the bar and the
 * ingredients are taken now, as each round is sent, so paying later changes neither. Adding to a tab replaces any printed bill.
 */
export async function addRound(i: { terminalId: string; userId: string; tableId?: string; tabId?: string; cart: Cart; seat?: number; idempotencyKey: string }): Promise<Tab> {
  const ctx = await getSellContext(i.terminalId)
  if (!ctx) throw new Error('Selling needs an open business day and an open shift on this terminal')
  if (ctx.shift.cashierId !== i.userId) throw new Error('This drawer belongs to another cashier')
  if (i.cart.lines.length === 0) throw new Error('The cart is empty')
  for (const l of i.cart.lines) if (l.comp) checkReason(l.comp.code, l.comp.note)
  if (i.seat !== undefined && (!Number.isInteger(i.seat) || i.seat < 1)) throw new Error('Seat must be 1 or more')

  const tab = await db.transaction('rw', [db.tabs, db.cafeTables, db.bills, db.queueItems, db.queueEvents, db.items, db.categories, db.stockMoves, db.recipes, db.ingredients, db.settings], async () => {
    let t = i.tabId ? await db.tabs.get(i.tabId) : undefined
    let table: CafeTable | undefined
    if (!t) {
      if (!i.tableId) throw new Error('Pick a table')
      table = await db.cafeTables.get(i.tableId)
      if (!table?.active) throw new Error('Pick an active table')
      if (table.branchId !== ctx.day.branchId) throw new Error('That table is at another branch')
      t = await openTabOn(table.id)
    }
    if (t && t.events.some((e) => e.detail?.key === i.idempotencyKey)) return { t, fresh: false, pseudo: undefined }
    if (!t) {
      t = { id: newId(), branchId: ctx.day.branchId, tableId: table!.id, label: table!.name, status: 'open', openedAt: new Date().toISOString(), openedBy: i.userId, shiftId: ctx.shift.id, cashierId: i.userId, lines: [], rounds: 0, settled: {}, events: [ev(i.userId, 'open')] }
      await db.tabs.add(t)
    }
    if (t.status !== 'open') throw new Error('This tab is closed')
    if (t.branchId !== ctx.day.branchId) throw new Error('That tab is at another branch')
    const round = t.rounds + 1
    const added: TabLine[] = i.cart.lines.map((l) => ({ ...l, addedBy: i.userId, round, ...(i.seat !== undefined && { seat: i.seat }) }))
    const next: Tab = { ...t, lines: [...t.lines, ...added], rounds: round, events: [...t.events, ev(i.userId, 'round', { round, lines: added.length, key: i.idempotencyKey })] }
    await db.tabs.put(next)
    // A printed bill no longer matches the tab: mark it so nobody pays from it.
    await db.bills.where('tabId').equals(t.id).and((b) => b.status === 'open').modify({ status: 'superseded' })
    const now = new Date().toISOString()
    const pseudo = { id: t.id, branchId: t.branchId, orderType: 'dine-in' as const, lines: added, paidAt: now, number: 0, name: '', table: t.label }
    await createQueueItems(pseudo, i.userId, { tabId: t.id })
    const sale = await deductSale(pseudo, i.userId)
    return { t: next, fresh: true, pseudo: sale }
  })
  if (tab.fresh && tab.pseudo) {
    await audit({ userId: i.userId, action: 'tab.round', ref: tab.t.id, detail: { round: tab.t.rounds, table: tab.t.label } })
    await alertAfterSale(tab.pseudo.crossed, i.userId)
    await syncModifierAvailability(i.userId).catch(() => {})
  }
  return tab.t
}

// ---- changing a tab ----
async function openTab(id: string) {
  const t = await db.tabs.get(id)
  if (!t || t.status !== 'open') throw new Error('That tab is not open')
  return t
}
const supersede = (tabId: string) => db.bills.where('tabId').equals(tabId).and((b) => b.status === 'open').modify({ status: 'superseded' })

/** The group moves to the sofa area. The history stays. The new table must be free (two groups joining is a merge). */
export async function moveTab(tabId: string, toTableId: string, userId: string) {
  const t = await openTab(tabId)
  const to = await db.cafeTables.get(toTableId)
  if (!to?.active || to.branchId !== t.branchId) throw new Error('Pick an active table at this branch')
  if (to.id === t.tableId) throw new Error('The tab is already at that table')
  if (await openTabOn(to.id)) throw new Error(`${to.name} already has a tab. Merge the tabs instead.`)
  await db.tabs.update(tabId, { tableId: to.id, label: to.name, events: [...t.events, ev(userId, 'move', { from: t.label, to: to.name })] })
  await audit({ userId, action: 'tab.move', ref: tabId, detail: { from: t.label, to: to.name } })
}

/** Tables 3 and 4 push together. Everything moves onto one tab, and every line keeps who added it and where it came from. */
export async function mergeTabs(intoId: string, fromId: string, userId: string) {
  if (intoId === fromId) throw new Error('Pick two different tabs')
  await db.transaction('rw', [db.tabs, db.bills, db.queueItems], async () => {
    const into = await openTab(intoId)
    const from = await openTab(fromId)
    if (into.branchId !== from.branchId) throw new Error('Those tabs are at different branches')
    const moved = from.lines.map((l) => ({ ...l, fromTable: l.fromTable ?? from.label }))
    const now = new Date().toISOString()
    await db.tabs.put({
      ...into, lines: [...into.lines, ...moved], rounds: Math.max(into.rounds, from.rounds), settled: { ...from.settled, ...into.settled },
      events: [...into.events, ev(userId, 'merge', { from: from.label, lines: moved.length })],
    })
    await db.tabs.put({ ...from, status: 'merged', mergedInto: into.id, closedAt: now, events: [...from.events, ev(userId, 'merge', { into: into.label })] })
    await db.queueItems.where('orderId').equals(from.id).modify({ orderId: into.id, tabId: into.id }) // the bar sees one table
    await supersede(into.id)
    await supersede(from.id)
  })
  await audit({ userId, action: 'tab.merge', ref: intoId, detail: { from: fromId } })
}

/** Shift change: the next cashier takes the tab. The lines keep the name of whoever added them. */
export async function transferTab(i: { tabId: string; terminalId: string; userId: string }) {
  const t = await openTab(i.tabId)
  const ctx = await getSellContext(i.terminalId)
  if (!ctx || ctx.shift.cashierId !== i.userId) throw new Error('Open your own shift on this terminal to take over a tab')
  if (t.cashierId === i.userId && t.shiftId === ctx.shift.id) throw new Error('This tab is already yours')
  if (ctx.day.branchId !== t.branchId) throw new Error('That tab is at another branch')
  await db.tabs.update(t.id, { shiftId: ctx.shift.id, cashierId: i.userId, events: [...t.events, ev(i.userId, 'transfer', { from: t.cashierId, to: i.userId })] })
  await audit({ userId: i.userId, action: 'tab.transfer', ref: t.id, detail: { from: t.cashierId } })
}

/** Who sat where, so the bill can be split by seat. */
export async function setLineSeat(tabId: string, lineId: string, seat: number | undefined, userId: string) {
  const t = await openTab(tabId)
  if (seat !== undefined && (!Number.isInteger(seat) || seat < 1)) throw new Error('Seat must be 1 or more')
  if (!t.lines.some((l) => l.id === lineId)) throw new Error('Line not found')
  await db.tabs.put({ ...t, lines: t.lines.map((l) => (l.id === lineId ? { ...l, seat } : l)), events: [...t.events, ev(userId, 'seat', { lineId, seat })] })
  await supersede(tabId)
}

/** How many people are at the table: a big group is offered the service charge when it is billed. */
export async function setGuests(tabId: string, guests: number, userId: string) {
  if (!Number.isInteger(guests) || guests < 0 || guests > 500) throw new Error('Guests must be 0 to 500')
  const t = await openTab(tabId)
  await db.tabs.update(tabId, { guests, events: [...t.events, ev(userId, 'seat', { guests })] })
}

// ---- bills ----
export type SplitRequest =
  | { mode: 'whole' }
  | { mode: 'item' | 'fraction'; payers: number; assign: Record<string, number[]> } // line id -> payers (several payers = the line is shared equally)
  | { mode: 'seat' }
  | { mode: 'even'; payers: number }
  | { mode: 'custom'; amounts: number[] }

/**
 * Prints the bill, whole or split (one bill per payer, each its own invoice when paid). The new bill replaces any earlier open one,
 * which is marked superseded. Only what is still unpaid is billed.
 */
export async function buildBill(tabId: string, req: SplitRequest, userId: string): Promise<Bill> {
  const bill = await db.transaction('rw', [db.tabs, db.bills], async () => {
    const t = await openTab(tabId)
    const d = dues(t.lines, t.settled)
    if (d.length === 0) throw new Error('Nothing is left to bill on this tab')
    const ids = () => newId()
    let parts: BillPart[]
    if (req.mode === 'whole') parts = partsByLines(d, Object.fromEntries(d.map((x) => [x.lineId, [0]])), ['Whole bill'], ids)
    else if (req.mode === 'item' || req.mode === 'fraction') parts = partsByLines(d, req.assign, Array.from({ length: req.payers }, (_, k) => `Payer ${k + 1}`), ids)
    else if (req.mode === 'seat') {
      const seats = [...new Set(t.lines.filter((l) => d.some((x) => x.lineId === l.id)).map((l) => l.seat))]
      if (seats.includes(undefined)) throw new Error('Some items have no seat. Give every item a seat first, or split by item.')
      const order = (seats as number[]).sort((a, b) => a - b)
      parts = partsByLines(d, Object.fromEntries(t.lines.filter((l) => d.some((x) => x.lineId === l.id)).map((l) => [l.id, [order.indexOf(l.seat!)]])), order.map((s) => `Seat ${s}`), ids)
    } else if (req.mode === 'even') parts = partsEven(d, req.payers, ids)
    else if (req.mode === 'custom') parts = partsCustom(d, req.amounts, ids)
    else throw new Error('Pick how to split the bill')
    await supersede(tabId)
    const version = ((await db.bills.where('tabId').equals(tabId).toArray()).reduce((m, b) => Math.max(m, b.version), 0)) + 1
    const b: Bill = { id: newId(), tabId, version, status: 'open', mode: req.mode, parts, at: new Date().toISOString(), by: userId }
    await db.bills.add(b)
    await db.tabs.put({ ...t, events: [...t.events, ev(userId, 'bill', { version, mode: req.mode, parts: parts.length })] })
    return b
  })
  await audit({ userId, action: 'tab.bill', ref: tabId, detail: { version: bill.version, mode: bill.mode, parts: bill.parts.length } })
  return bill
}

/**
 * Called inside payOrder's transaction when a bill part is paid: marks the part paid, counts what it settled against the tab's lines,
 * and closes the bill and the tab when nothing is left. Refuses a superseded bill and a part whose amount no longer matches.
 */
export async function settleBillPart(order: Pick<Order, 'id' | 'gross'>, billId: string, partId: string, userId: string) {
  const bill = await db.bills.get(billId)
  if (!bill) throw new Error('Bill not found')
  if (bill.status === 'superseded') throw new Error('This bill was replaced by a newer one. Open the latest bill from the tab.')
  if (bill.status !== 'open') throw new Error('This bill is already settled')
  const part = bill.parts.find((p) => p.id === partId)
  if (!part || part.paidOrderId) throw new Error('This part of the bill is already paid')
  if (part.amount !== order.gross) throw new Error('The amount no longer matches the bill. Go back to the tab and print a new bill.')
  const t = await openTab(bill.tabId)
  const settled = { ...t.settled }
  let loose = 0 // amounts from an even or custom split are not tied to a line: they pay off the oldest unpaid lines first
  for (const bl of part.lines) {
    if (bl.lineId) settled[bl.lineId] = (settled[bl.lineId] ?? 0) + bl.amount
    else loose += bl.amount
  }
  for (const d of dues(t.lines, settled)) {
    if (loose <= 0) break
    const take = Math.min(loose, d.due)
    settled[d.lineId] = (settled[d.lineId] ?? 0) + take
    loose -= take
  }
  for (const l of t.lines) if (lineTotal(l) === 0 && !(l.id in settled) && part.lines.some((x) => x.lineId === l.id)) settled[l.id] = 0
  const parts = bill.parts.map((p) => (p.id === partId ? { ...p, paidOrderId: order.id } : p))
  const allPaid = parts.every((p) => p.paidOrderId)
  await db.bills.update(bill.id, { parts, status: allPaid ? 'closed' : 'open' })
  const left = dues(t.lines, settled).reduce((s, d) => s + d.due, 0)
  const closes = allPaid && left === 0
  await db.tabs.put({
    ...t, settled, ...(closes && { status: 'closed' as const, closedAt: new Date().toISOString() }),
    events: [...t.events, ev(userId, 'paid', { part: part.label, amount: part.amount, order: order.id })],
  })
}

// ---- walkout ----
/**
 * The table left without paying. Closed as a walkout with a supervisor PIN and a reason: a loss in the reports, not a void
 * (the drinks were made and the ingredients are gone). What was unpaid is recorded as the loss.
 */
export async function walkoutTab(i: { tabId: string; terminalId: string; userId: string; reason: string; approvalId?: string }) {
  if (!i.reason.trim()) throw new Error('A reason is required')
  const ctx = await getSellContext(i.terminalId)
  if (!ctx) throw new Error('Open a business day and a shift on this terminal first')
  const date = businessDate(new Date(), await getSetting('dayCutoffHour'))
  const t = await db.transaction('rw', [db.tabs, db.bills, db.approvals, db.users, db.settings], async () => {
    const tab = await openTab(i.tabId)
    const amount = tabTotals(tab).due
    const approvedBy = await consumeApproval(i.userId, 'walkout', amount, tab.id, i.approvalId, tab.id)
    if (!approvedBy) throw new Error('This needs a supervisor PIN')
    const closed: Tab = {
      ...tab, status: 'walkout', closedAt: new Date().toISOString(), walkout: { amount, reason: i.reason.trim(), approvedBy, businessDate: ctx.day.date || date, shiftId: ctx.shift.id },
      events: [...tab.events, ev(i.userId, 'walkout', { amount, reason: i.reason.trim(), approvedBy })],
    }
    await db.tabs.put(closed)
    await supersede(tab.id)
    return closed
  })
  await audit({ userId: i.userId, approverId: t.walkout!.approvedBy, action: 'tab.walkout', ref: t.id, detail: { amount: t.walkout!.amount, reason: t.walkout!.reason, table: t.label } })
  return t
}
