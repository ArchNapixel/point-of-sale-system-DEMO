import { db, type Modifier, type ModifierGroup } from './db'
import { newId } from '../lib/id'
import { audit } from './audit'
import type { GroupWithMods } from '../lib/modifierPricing'

type GroupInput = { name: string; min: number; max: number }
type ModifierInput = { name: string; price: number; sizePrices: Record<string, number>; freeQty: number; maxQty: number }

const isInt = (n: number, min: number) => Number.isInteger(n) && n >= min

function checkGroup(g: GroupInput) {
  if (!g.name.trim()) throw new Error('Group name is required')
  if (!isInt(g.min, 0) || !isInt(g.max, 1) || g.max < g.min) throw new Error('Max must be at least 1 and not less than min')
}

function checkModifier(m: ModifierInput) {
  if (!m.name.trim()) throw new Error('Option name is required')
  const prices = [m.price, ...Object.values(m.sizePrices)]
  if (prices.some((p) => !isInt(p, 0))) throw new Error('Prices must be whole centavos, 0 or more')
  if (!isInt(m.maxQty, 1)) throw new Error('Max quantity must be at least 1')
  if (!isInt(m.freeQty, 0) || m.freeQty > m.maxQty) throw new Error('Free quantity must be between 0 and max quantity')
}

export async function createGroup(g: GroupInput): Promise<ModifierGroup> {
  checkGroup(g)
  const all = await db.modifierGroups.toArray()
  if (all.some((x) => x.active && x.name.toLowerCase() === g.name.trim().toLowerCase())) throw new Error(`"${g.name.trim()}" already exists`)
  const row: ModifierGroup = { id: newId(), name: g.name.trim(), min: g.min, max: g.max, sort: all.length, active: true }
  await db.modifierGroups.add(row)
  return row
}

export async function updateGroup(id: string, g: GroupInput) {
  checkGroup(g)
  await db.modifierGroups.update(id, { name: g.name.trim(), min: g.min, max: g.max })
}

export async function createModifier(groupId: string, m: ModifierInput, userId: string): Promise<Modifier> {
  checkModifier(m)
  if (!(await db.modifierGroups.get(groupId))) throw new Error('Group not found')
  const siblings = await db.modifiers.where('groupId').equals(groupId).toArray()
  if (siblings.some((x) => x.active && x.name.toLowerCase() === m.name.trim().toLowerCase())) throw new Error(`"${m.name.trim()}" is already in this group`)
  const row: Modifier = { id: newId(), groupId, ...m, name: m.name.trim(), soldOut: false, sort: siblings.length, active: true }
  await db.modifiers.add(row)
  await audit({ userId, action: 'modifier.create', ref: row.id, detail: { price: row.price, sizePrices: row.sizePrices } })
  return row
}

export async function updateModifier(id: string, m: ModifierInput, userId: string) {
  checkModifier(m)
  const old = await db.modifiers.get(id)
  if (!old) throw new Error('Option not found')
  await db.modifiers.update(id, { ...m, name: m.name.trim() })
  if (old.price !== m.price || JSON.stringify(old.sizePrices) !== JSON.stringify(m.sizePrices) || old.freeQty !== m.freeQty) {
    await audit({
      userId, action: 'modifier.price', ref: id,
      detail: { from: { price: old.price, sizePrices: old.sizePrices, freeQty: old.freeQty }, to: { price: m.price, sizePrices: m.sizePrices, freeQty: m.freeQty } },
    })
  }
}

// A person's choice wins: it clears the system's own "ran out" flag, so stock coming back will not undo it.
export const setModifierSoldOut = (id: string, soldOut: boolean) => db.modifiers.update(id, { soldOut, autoSoldOut: false })

/** Archive or restore. Never delete (design rule 3). */
export async function setModifierActive(table: 'modifierGroups' | 'modifiers', id: string, active: boolean) {
  await db[table].update(id, { active })
}

export async function setItemGroup(itemId: string, groupId: string, on: boolean) {
  const item = await db.items.get(itemId)
  if (!item) throw new Error('Item not found')
  if (on && !(await db.modifierGroups.get(groupId))) throw new Error('Group not found')
  const ids = (item.groupIds ?? []).filter((g) => g !== groupId)
  await db.items.update(itemId, { groupIds: on ? [...ids, groupId] : ids })
}

/** The add-on groups the order screen shows for an item: active groups with active options, in order. */
export async function getItemModifiers(itemId: string): Promise<GroupWithMods[]> {
  const item = await db.items.get(itemId)
  const ids = item?.groupIds ?? []
  const groups = (await db.modifierGroups.bulkGet(ids)).filter((g): g is ModifierGroup => !!g?.active)
  const out: GroupWithMods[] = []
  for (const id of ids) {
    const g = groups.find((x) => x.id === id)
    if (!g) continue
    const mods = (await db.modifiers.where('groupId').equals(id).toArray()).filter((m) => m.active).sort((a, b) => a.sort - b.sort)
    out.push({ ...g, modifiers: mods })
  }
  return out
}
