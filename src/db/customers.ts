import { db, type Customer } from './db'
import { newId } from '../lib/id'
import { audit } from './audit'

const digits = (s: string) => s.replace(/\D/g, '')

/**
 * Saves a customer profile. Only with consent (Data Privacy Act): the cashier confirms the customer agreed to us keeping their
 * name and number. A number that already has a profile is refused: merge instead.
 */
export async function createCustomer(i: { name: string; phone?: string; consent: boolean; userId: string }): Promise<Customer> {
  if (!i.consent) throw new Error('A profile is saved only with the customer’s consent')
  const name = i.name.trim()
  if (!name) throw new Error('Enter the customer’s name')
  const phone = i.phone ? digits(i.phone) : ''
  if (i.phone?.trim() && phone.length < 7) throw new Error('Enter the full mobile number')
  if (phone && (await db.customers.filter((c) => c.active && c.phone === phone).count()) > 0) throw new Error('That number already has a profile. Look it up, or merge the profiles.')
  const now = new Date().toISOString()
  const c: Customer = { id: newId(), name, ...(phone && { phone }), consentAt: now, consentBy: i.userId, createdAt: now, active: true }
  await db.customers.add(c)
  await db.outbox.add({ id: newId(), table: 'customers', recordId: c.id, at: now, synced: 0 })
  await audit({ userId: i.userId, action: 'customer.create', ref: c.id })
  return c
}

/** "Under Joy, 0917…": find by part of the name or the last 4 digits of the number. */
export async function searchCustomers(q: string): Promise<Customer[]> {
  const t = q.trim().toLowerCase()
  if (!t) return []
  const d = digits(t)
  return (await db.customers.filter((c) => c.active).toArray())
    .filter((c) => c.name.toLowerCase().includes(t) || (d.length >= 4 && !!c.phone && c.phone.endsWith(d)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20)
}

/** A profile and every profile merged into it: their history counts as one person's. */
export async function familyIds(id: string): Promise<string[]> {
  const all = await db.customers.toArray()
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of all) if (c.mergedInto && out.has(c.mergedInto) && !out.has(c.id)) { out.add(c.id); grew = true }
  }
  return [...out]
}

/** Changed SIM, new number, two accounts: one profile survives and all history follows it. Nothing is rewritten. */
export async function mergeCustomers(intoId: string, fromId: string, userId: string) {
  if (intoId === fromId) throw new Error('Pick two different profiles')
  const [into, from] = await Promise.all([db.customers.get(intoId), db.customers.get(fromId)])
  if (!into?.active || !from?.active) throw new Error('Both profiles must be active')
  await db.customers.update(fromId, { mergedInto: intoId, active: false })
  await audit({ userId, action: 'customer.merge', ref: intoId, detail: { from: fromId } })
}

/**
 * "Remove my info": the profile (and any profile merged into it) loses its name and number, and past sales lose the name printed on them.
 * The sales, stamps and points stay, without personal details.
 */
export async function anonymizeCustomer(id: string, userId: string) {
  const c = await db.customers.get(id)
  if (!c) throw new Error('Customer not found')
  const ids = await familyIds(id)
  const now = new Date().toISOString()
  await db.transaction('rw', [db.customers, db.orders], async () => {
    for (const cid of ids) {
      await db.customers.update(cid, { name: 'Deleted customer', phone: undefined, active: false, anonymizedAt: now })
    }
    await db.orders.filter((o) => !!o.customerId && ids.includes(o.customerId)).modify({ name: '' })
  })
  await audit({ userId, action: 'customer.anonymize', ref: id, detail: { profiles: ids.length } })
}
