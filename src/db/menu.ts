import { db, type Category, type Item, type Variant } from './db'
import { newId } from '../lib/id'
import { audit } from './audit'

export const variantLabel = (v: Pick<Variant, 'size' | 'temp'>): string =>
  [v.size, v.temp === 'hot' ? 'Hot' : v.temp === 'iced' ? 'Iced' : ''].filter(Boolean).join(' · ') || 'Regular'

export async function createCategory(name: string): Promise<Category> {
  const n = name.trim()
  if (!n) throw new Error('Category name is required')
  const all = await db.categories.toArray()
  if (all.some((c) => c.name.toLowerCase() === n.toLowerCase())) throw new Error(`"${n}" already exists`)
  const c: Category = { id: newId(), name: n, sort: all.length, active: true }
  await db.categories.add(c)
  return c
}

export async function createItem(categoryId: string, name: string): Promise<Item> {
  const n = name.trim()
  if (!n) throw new Error('Item name is required')
  if (!(await db.categories.get(categoryId))) throw new Error('Pick a category')
  const dup = (await db.items.where('categoryId').equals(categoryId).toArray()).some(
    (i) => i.active && i.name.toLowerCase() === n.toLowerCase(),
  )
  if (dup) throw new Error(`"${n}" is already in this category`)
  const i: Item = { id: newId(), categoryId, name: n, soldOut: false, active: true }
  await db.items.add(i)
  return i
}

export async function renameItem(id: string, name: string) {
  if (!name.trim()) throw new Error('Item name is required')
  await db.items.update(id, { name: name.trim() })
}

export const setSoldOut = (itemId: string, soldOut: boolean) => db.items.update(itemId, { soldOut })

/** Archive or restore. Never delete: old sales still point at these (design rule 3). */
export async function setMenuActive(table: 'categories' | 'items' | 'variants', id: string, active: boolean) {
  await db[table].update(id, { active })
}

type VariantInput = { size?: string; temp?: 'hot' | 'iced'; price: number }

function checkVariant(v: VariantInput) {
  if (!Number.isInteger(v.price) || v.price < 0) throw new Error('Price must be a whole number of centavos, 0 or more')
}

/** One active variant per size + temperature within an item. */
async function assertUnique(itemId: string, v: VariantInput, exceptId?: string) {
  const size = v.size?.trim().toLowerCase() ?? ''
  const same = (await db.variants.where('itemId').equals(itemId).toArray()).some(
    (o) => o.active && o.id !== exceptId && (o.size?.toLowerCase() ?? '') === size && o.temp === v.temp,
  )
  if (same) throw new Error('That size and temperature already exists for this item')
}

export async function createVariant(itemId: string, v: VariantInput, userId: string): Promise<Variant> {
  checkVariant(v)
  if (!(await db.items.get(itemId))) throw new Error('Item not found')
  await assertUnique(itemId, v)
  const row: Variant = { id: newId(), itemId, size: v.size?.trim() || undefined, temp: v.temp, price: v.price, active: true }
  await db.variants.add(row)
  await audit({ userId, action: 'variant.create', ref: row.id, detail: { itemId, price: row.price } })
  return row
}

export async function updateVariant(id: string, v: VariantInput, userId: string) {
  checkVariant(v)
  const old = await db.variants.get(id)
  if (!old) throw new Error('Variant not found')
  await assertUnique(old.itemId, v, id)
  await db.variants.update(id, { size: v.size?.trim() || undefined, temp: v.temp, price: v.price })
  if (old.price !== v.price) await audit({ userId, action: 'variant.price', ref: id, detail: { from: old.price, to: v.price } })
}

/** What the order screen shows: active categories > active items > active variants. Sold-out items stay (greyed out). */
export async function getSellableMenu() {
  const [cats, items, variants] = await Promise.all([db.categories.toArray(), db.items.toArray(), db.variants.toArray()])
  return cats
    .filter((c) => c.active)
    .sort((a, b) => a.sort - b.sort)
    .map((c) => ({
      ...c,
      items: items
        .filter((i) => i.active && i.categoryId === c.id)
        .sort((a, b) => a.name.localeCompare(b.name)) // ponytail: alphabetical; add favourites/manual order when cashiers ask
        .map((i) => ({ ...i, variants: variants.filter((v) => v.active && v.itemId === i.id).sort((a, b) => a.price - b.price) }))
        .filter((i) => i.variants.length > 0),
    }))
    .filter((c) => c.items.length > 0)
}
