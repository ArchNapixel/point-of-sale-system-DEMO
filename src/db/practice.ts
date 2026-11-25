import { db, type PracticeSale } from './db'
import { newId } from '../lib/id'
import { cartCount, cartTotal, type Cart } from '../lib/cart'
import { applyLines, type PayLine } from '../lib/payments'
import { formatPeso } from '../lib/money'
import { can } from '../lib/roles'

/**
 * A practice sale for a new cashier. It runs the same payment rules (change, short cash, references) but writes no order, no invoice
 * number, no stock movement, no queue ticket and no money: it lives in its own table, so no report can ever see it.
 */
export async function payPractice(userId: string, cart: Cart, lines: PayLine[]): Promise<PracticeSale> {
  const user = await db.users.get(userId)
  if (!user || !(can(user.role, 'trainingOnly') || can(user.role, 'approve'))) throw new Error('Training mode is for trainees and supervisors')
  if (cartCount(cart) === 0) throw new Error('The cart is empty')
  const total = cartTotal(cart)
  const { applied, remaining, change } = applyLines(total, lines)
  if (remaining > 0) throw new Error(`${formatPeso(remaining)} still to pay`)
  const sale: PracticeSale = { id: newId(), userId, at: new Date().toISOString(), lines: cart.lines, total, payments: applied.map((a) => ({ method: a.method, amount: a.amount })), change }
  await db.practiceSales.add(sale)
  return sale
}
