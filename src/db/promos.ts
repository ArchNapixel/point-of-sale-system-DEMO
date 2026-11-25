import { db } from './db'
import type { Promo } from '../lib/promos'
import { newId } from '../lib/id'
import { audit } from './audit'
import { ymdLocal } from '../lib/promos'

type Input = Omit<Promo, 'id' | 'active'>
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function createPromo(i: Input, userId: string): Promise<Promo> {
  if (!i.name.trim()) throw new Error('Promo name is required')
  if (i.kind === 'percent' && !(i.value > 0 && i.value <= 100)) throw new Error('Percent must be between 1 and 100')
  if (i.kind === 'amount' && !(Number.isInteger(i.value) && i.value > 0)) throw new Error('Enter the peso amount off')
  if (!Number.isInteger(i.minSpend) || i.minSpend < 0) throw new Error('Minimum spend cannot be negative')
  if ((i.from && !TIME.test(i.from)) || (i.to && !TIME.test(i.to))) throw new Error('Times look like 15:00')
  if (i.from && i.to && i.to <= i.from) throw new Error('The end time must be after the start time')
  if ((i.startDate && !DATE.test(i.startDate)) || (i.endDate && !DATE.test(i.endDate))) throw new Error('Dates look like 2026-12-31')
  if (i.startDate && i.endDate && i.endDate < i.startDate) throw new Error('The end date is before the start date')
  if (!Number.isInteger(i.maxUses) || i.maxUses < 0) throw new Error('Uses must be 0 (unlimited) or more')
  const code = i.code.trim().toUpperCase()
  if (code && (await db.promos.where('code').equals(code).count()) > 0) throw new Error(`Code ${code} already exists`)
  const p: Promo = { ...i, name: i.name.trim(), code, id: newId(), active: true }
  await db.promos.add(p)
  await audit({ userId, action: 'promo.create', ref: p.id, detail: { name: p.name, kind: p.kind, value: p.value, code: p.code || undefined } })
  return p
}

/** Switch off, never delete: past orders point at it (rule 3). */
export async function setPromoActive(id: string, active: boolean, userId: string) {
  await db.promos.update(id, { active })
  await audit({ userId, action: active ? 'promo.on' : 'promo.off', ref: id })
}

export const promoUseCount = (promoId: string) => db.promoUses.where('promoId').equals(promoId).count()

/** Checks a typed voucher code. Returns the promo, or says why it can't be used (unknown, off, expired, used up). */
export async function checkCode(raw: string, now = new Date()): Promise<Promo> {
  const code = raw.trim().toUpperCase()
  if (!code) throw new Error('Enter a code')
  const p = await db.promos.where('code').equals(code).first()
  if (!p) throw new Error('No promo has that code')
  if (!p.active) throw new Error('That promo is switched off')
  const today = ymdLocal(now)
  if (p.startDate && today < p.startDate) throw new Error(`That code starts on ${p.startDate}`)
  if (p.endDate && today > p.endDate) throw new Error('That code has expired')
  if (p.maxUses > 0 && (await promoUseCount(p.id)) >= p.maxUses) throw new Error('That code was already used')
  return p
}
