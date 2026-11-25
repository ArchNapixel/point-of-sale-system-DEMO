import { db, type Order, type QueueEvent, type QueueItem } from './db'
import { businessDate } from './businessDate'
import { getSetting } from './settings'
import { checkReason } from '../lib/reasons'
import { can } from '../lib/roles'
import { newId } from '../lib/id'
import { FLOW, UNDO_MS, type QueueStatus } from '../lib/queue'

/**
 * Turns a paid order's lines into bar/kitchen ticket rows. A line's station comes from its item's category;
 * "No prep" lines get no ticket and complete on their own. Call inside the sale's transaction (needs queueItems, queueEvents).
 */
export async function createQueueItems(order: Order, userId: string) {
  const rows: QueueItem[] = []
  for (const l of order.lines) {
    const item = await db.items.get(l.itemId)
    const station = (item && (await db.categories.get(item.categoryId))?.station) ?? 'bar'
    if (station === 'none') continue
    rows.push({
      id: newId(), orderId: order.id, orderNumber: order.number, orderLabel: order.name || (order.table && `Table ${order.table}`) || '',
      orderType: order.orderType, lineId: l.id, station, name: l.name, variantLabel: l.variantLabel,
      mods: l.mods.map((m) => `${m.name}${m.qty > 1 ? ` ×${m.qty}` : ''}`), notes: l.notes, allergy: l.allergy, qty: l.qty,
      status: 'queued', statusAt: order.paidAt, rush: false, createdAt: order.paidAt,
    })
  }
  await db.queueItems.bulkAdd(rows)
  await db.queueEvents.bulkAdd(rows.map((r) => ({ id: newId(), itemId: r.id, status: 'queued', userId, at: order.paidAt })))
}

const event = (itemId: string, status: QueueStatus, userId: string, note?: string): QueueEvent =>
  ({ id: newId(), itemId, status, userId, at: new Date().toISOString(), ...(note && { note }) })

/** Moves an item forward (queued → making → ready → served). Going back is only possible with undoStatus. */
export async function setItemStatus(itemId: string, status: QueueStatus, userId: string) {
  await db.transaction('rw', db.queueItems, db.queueEvents, async () => {
    const i = await db.queueItems.get(itemId)
    if (!i) throw new Error('Ticket not found')
    if (FLOW.indexOf(status) <= FLOW.indexOf(i.status)) throw new Error(`Already ${i.status}`)
    await db.queueItems.update(itemId, { status, prevStatus: i.status, statusAt: new Date().toISOString() })
    await db.queueEvents.add(event(itemId, status, userId))
  })
}

/** Undo for a short time after a wrong tap. The history keeps both changes. */
export async function undoStatus(itemId: string, userId: string) {
  await db.transaction('rw', db.queueItems, db.queueEvents, async () => {
    const i = await db.queueItems.get(itemId)
    if (!i?.prevStatus || Date.now() - Date.parse(i.statusAt) > UNDO_MS) throw new Error('Too late to undo')
    await db.queueItems.update(itemId, { status: i.prevStatus, prevStatus: undefined, statusAt: new Date().toISOString() })
    await db.queueEvents.add(event(itemId, i.prevStatus, userId, `undo of ${i.status}`))
  })
}

/** Moves every unfinished item of an order to the top of the queue, with the reason shown. */
export async function setRush(orderId: string, reason: string, userId: string) {
  if (!reason.trim()) throw new Error('Pick a reason for the rush')
  await db.transaction('rw', db.queueItems, db.queueEvents, async () => {
    const items = (await db.queueItems.where('orderId').equals(orderId).toArray()).filter((i) => i.status !== 'served')
    for (const i of items) {
      await db.queueItems.update(i.id, { rush: true, rushReason: reason.trim() })
      await db.queueEvents.add(event(i.id, i.status, userId, `rush: ${reason.trim()}`))
    }
  })
}

/**
 * Made wrong or spilled: the ticket is made again, no money moves, and the first cup is waste (3C will deduct both).
 * The remake goes to the top of the queue marked "Remake". Barista, supervisor or owner. Counts per drink and per person are kept.
 */
export async function remakeItem(itemId: string, userId: string, reasonCode: string, reasonNote?: string) {
  checkReason(reasonCode, reasonNote)
  const user = await db.users.get(userId)
  if (!user || !can(user.role, 'remake')) throw new Error('Your role cannot remake drinks. Ask a barista or supervisor.')
  const now = new Date()
  const date = businessDate(now, await getSetting('dayCutoffHour'))
  return db.transaction('rw', db.queueItems, db.queueEvents, db.remakes, async () => {
    const old = await db.queueItems.get(itemId)
    if (!old) throw new Error('Ticket not found')
    if (old.status === 'void') throw new Error('That ticket was already replaced or cancelled')
    const copy: QueueItem = {
      ...old, id: newId(), status: 'queued', statusAt: now.toISOString(), prevStatus: undefined, rush: true, rushReason: 'Remake', remakeOf: old.id, wasted: undefined,
    }
    await db.queueItems.update(old.id, { status: 'void', prevStatus: undefined, wasted: true, statusAt: now.toISOString() })
    await db.queueItems.add(copy)
    await db.queueEvents.bulkAdd([
      { id: newId(), itemId: old.id, status: 'void', userId, at: now.toISOString(), note: `remake: ${reasonCode}` },
      { id: newId(), itemId: copy.id, status: 'queued', userId, at: now.toISOString(), note: 'remake' },
    ])
    await db.remakes.add({
      id: newId(), itemId: old.id, newItemId: copy.id, orderId: old.orderId, name: old.name, station: old.station, qty: old.qty,
      reasonCode, ...(reasonNote?.trim() && { reasonNote: reasonNote.trim() }), userId, businessDate: date, at: now.toISOString(),
    })
    return copy
  })
}
