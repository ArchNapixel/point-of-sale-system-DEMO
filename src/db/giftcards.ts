import { db, type GiftCard, type GiftCardTx } from './db'
import { newId } from '../lib/id'
import { cardBalance, newCardNumber, normCard } from '../lib/giftcards'
import { normRef, type PayMethod } from '../lib/payments'
import { can } from '../lib/roles'
import { audit } from './audit'
import { getSellContext } from './shifts'

const SELL_METHODS: PayMethod[] = ['cash', 'gcash', 'maya', 'card', 'transfer']

export const giftBalance = async (cardId: string) => cardBalance(await db.giftCardTx.where('cardId').equals(cardId).toArray())

const findByNumber = async (number: string) => db.giftCards.where('number').equals(normCard(number)).first()

/**
 * Sells a gift card: money paid now for drinks later. It is a liability until used, never a sale. Cash goes in this drawer.
 * (A gift card slip is printed instead of an invoice; the sale of drinks happens when it is spent.)
 */
export async function sellGiftCard(i: { terminalId: string; userId: string; amount: number; method: PayMethod; reference?: string; buyerId?: string }): Promise<GiftCard> {
  const ctx = await getSellContext(i.terminalId)
  if (!ctx) throw new Error('Selling needs an open business day and an open shift on this terminal')
  if (ctx.shift.cashierId !== i.userId) throw new Error('This drawer belongs to another cashier')
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new Error('Enter the card amount in pesos')
  if (!SELL_METHODS.includes(i.method)) throw new Error('Pick how it was paid')
  if (i.method !== 'cash' && !normRef(i.reference)) throw new Error('Enter the reference number of the payment')
  if (i.buyerId && !(await db.customers.get(i.buyerId))?.active) throw new Error('That customer profile is not active')
  let number = newCardNumber()
  while (await findByNumber(number)) number = newCardNumber()
  const now = new Date().toISOString()
  const card: GiftCard = { id: newId(), number, ...(i.buyerId && { buyerId: i.buyerId }), issuedAt: now, issuedBy: i.userId, status: 'active' }
  const tx: GiftCardTx = {
    id: newId(), cardId: card.id, kind: 'issue', amount: i.amount, balanceAfter: i.amount, at: now, by: i.userId,
    paid: { method: i.method, ...(i.reference && { reference: normRef(i.reference) }), shiftId: ctx.shift.id },
  }
  await db.transaction('rw', [db.giftCards, db.giftCardTx, db.outbox], async () => {
    await db.giftCards.add(card)
    await db.giftCardTx.add(tx)
    await db.outbox.bulkAdd([{ id: newId(), table: 'giftCards', recordId: card.id, at: now, synced: 0 }, { id: newId(), table: 'giftCardTx', recordId: tx.id, at: now, synced: 0 }])
  })
  await audit({ userId: i.userId, action: 'giftcard.sell', ref: card.id, detail: { number, amount: i.amount, method: i.method } })
  return card
}

/** Spends from a card as part of a sale. Runs inside the sale's transaction. A card cannot go below zero. */
export async function redeemCard(number: string, amount: number, orderId: string, userId: string) {
  const card = await findByNumber(number)
  if (!card) throw new Error(`No gift card ${normCard(number)}`)
  if (card.status !== 'active') throw new Error('That gift card was replaced. Use the new card.')
  const bal = await giftBalance(card.id)
  if (amount > bal) throw new Error(`That card has only ₱${(bal / 100).toFixed(2)} left`)
  const tx: GiftCardTx = { id: newId(), cardId: card.id, kind: 'redeem', amount: -amount, balanceAfter: bal - amount, orderId, at: new Date().toISOString(), by: userId }
  await db.giftCardTx.add(tx)
  return tx
}

/** Money going back onto a card: a refund to the card, or a voided sale that was paid with it. Runs inside the refund's transaction. */
export async function creditCard(number: string, amount: number, orderId: string, userId: string) {
  const card = await findByNumber(number)
  if (!card) throw new Error(`No gift card ${normCard(number)}`)
  const target = card.reissuedAs ? (await db.giftCards.get(card.reissuedAs)) ?? card : card // a replaced card's money lives on the new one
  const bal = await giftBalance(target.id)
  await db.giftCardTx.add({ id: newId(), cardId: target.id, kind: 'refund', amount, balanceAfter: bal + amount, orderId, at: new Date().toISOString(), by: userId })
}

/** Look up by card number or by the buyer's name (a lost card: "I lost it but I have the receipt"). */
export async function findCards(q: string) {
  const t = q.trim().toLowerCase()
  if (!t) return []
  const customers = await db.customers.toArray()
  const cards = (await db.giftCards.toArray()).filter((c) => c.number.toLowerCase().includes(t) || (c.buyerId && customers.find((x) => x.id === c.buyerId)?.name.toLowerCase().includes(t)))
  return Promise.all(cards.map(async (c) => ({ ...c, balance: await giftBalance(c.id), buyer: customers.find((x) => x.id === c.buyerId)?.name })))
}

/** The owner reissues a lost card's remaining balance on a new card. The old number stops working. */
export async function reissueGiftCard(cardId: string, userId: string): Promise<GiftCard> {
  const user = await db.users.get(userId)
  if (!user || !can(user.role, 'editPrices')) throw new Error('Only the owner reissues a gift card')
  const old = await db.giftCards.get(cardId)
  if (!old || old.status !== 'active') throw new Error('That card cannot be reissued')
  const bal = await giftBalance(cardId)
  if (bal <= 0) throw new Error('That card has nothing left')
  let number = newCardNumber()
  while (await findByNumber(number)) number = newCardNumber()
  const now = new Date().toISOString()
  const card: GiftCard = { id: newId(), number, ...(old.buyerId && { buyerId: old.buyerId }), issuedAt: now, issuedBy: userId, status: 'active' }
  await db.transaction('rw', [db.giftCards, db.giftCardTx], async () => {
    await db.giftCards.add(card)
    await db.giftCards.update(cardId, { status: 'void', reissuedAs: card.id })
    await db.giftCardTx.bulkAdd([
      { id: newId(), cardId, kind: 'reissue-out', amount: -bal, balanceAfter: 0, at: now, by: userId },
      { id: newId(), cardId: card.id, kind: 'reissue-in', amount: bal, balanceAfter: bal, at: now, by: userId },
    ])
  })
  await audit({ userId, action: 'giftcard.reissue', ref: cardId, detail: { newNumber: number, balance: bal } })
  return card
}
