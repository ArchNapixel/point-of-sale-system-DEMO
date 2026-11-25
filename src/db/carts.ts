import { db, type HeldCart } from './db'
import { newId } from '../lib/id'
import { cartCount, type Cart } from '../lib/cart'

/** Sets a cart aside (customer still deciding). The label is the customer's name, else the table, else the time. */
export async function holdCart(terminalId: string, shiftId: string, userId: string, cart: Cart): Promise<HeldCart> {
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  const now = new Date()
  const row: HeldCart = {
    id: newId(),
    terminalId,
    shiftId,
    heldBy: userId,
    heldAt: now.toISOString(),
    label: cart.name.trim() || (cart.table.trim() ? `Table ${cart.table.trim()}` : `Held ${now.toLocaleTimeString('en-PH', { timeStyle: 'short' })}`),
    cart,
    status: 'held',
  }
  await db.heldCarts.add(row)
  return row
}

export const listHeld = async (terminalId: string): Promise<HeldCart[]> =>
  (await db.heldCarts.where('terminalId').equals(terminalId).toArray())
    .filter((h) => h.status === 'held')
    .sort((a, b) => a.heldAt.localeCompare(b.heldAt))

/** Takes a held cart back. Returns its contents; the held row stays as history, marked resumed. */
export async function resumeHeld(id: string): Promise<Cart> {
  return db.transaction('rw', db.heldCarts, async () => {
    const h = await db.heldCarts.get(id)
    if (!h || h.status !== 'held') throw new Error('That cart is no longer held')
    await db.heldCarts.update(id, { status: 'resumed' })
    return h.cart
  })
}

export async function discardHeld(id: string) {
  await db.heldCarts.update(id, { status: 'discarded' })
}
