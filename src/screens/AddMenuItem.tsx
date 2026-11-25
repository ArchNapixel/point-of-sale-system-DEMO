import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { createMenuItem } from '../db/menu'
import { parsePesos } from '../lib/money'
import { Err, useAction } from '../ui'

type Row = { key: number; size: string; temp: '' | 'hot' | 'iced'; price: string }
const NEW = '__new'

/** One form to create a whole menu item: category, name, prices and add-ons. Saves all or nothing. */
export default function AddMenuItem({ userId, onDone }: { userId: string; onDone: () => void }) {
  const categories = useLiveQuery(() => db.categories.toArray().then((c) => c.filter((x) => x.active).sort((a, b) => a.sort - b.sort)), [])
  const groups = useLiveQuery(() => db.modifierGroups.toArray().then((g) => g.filter((x) => x.active).sort((a, b) => a.sort - b.sort)), [])
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([{ key: 0, size: '', temp: '', price: '' }])
  const [picked, setPicked] = useState<string[]>([])
  const { error, run } = useAction()
  if (!categories || !groups) return null

  // No categories yet, or "New category" chosen: type one in.
  const creating = categories.length === 0 || categoryId === NEW
  const chosen = creating ? '' : categoryId || categories[0].id
  const setRow = (key: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const valid =
    name.trim() !== '' &&
    (creating ? newCategory.trim() !== '' : chosen !== '') &&
    rows.length > 0 &&
    rows.every((r) => parsePesos(r.price) !== null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    const ok = await run(() =>
      createMenuItem(
        {
          categoryId: chosen || undefined,
          newCategory: creating ? newCategory : undefined,
          name,
          variants: rows.map((r) => ({ size: r.size, temp: r.temp || undefined, price: parsePesos(r.price)! })),
          groupIds: picked,
        },
        userId,
      ),
    )
    if (ok) onDone()
  }

  return (
    <form onSubmit={submit} className="card add-item">
      <h3>Add menu item</h3>

      <label>
        Category
        {categories.length > 0 && (
          <select value={creating ? NEW : chosen} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>+ New category…</option>
          </select>
        )}
      </label>
      {creating && (
        <input aria-label="New category name" placeholder="New category (Espresso, Tea, Pastries…)" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} autoFocus />
      )}

      <label>
        Item name
        <input placeholder="Latte" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!creating} />
      </label>

      <fieldset>
        <legend>Prices</legend>
        <p><small>One row per size or temperature. Leave size blank and pick no temperature for a single price.</small></p>
        {rows.map((r) => (
          <div key={r.key} className="row">
            <input aria-label="Size" placeholder="Size (16 oz)" size={12} value={r.size} onChange={(e) => setRow(r.key, { size: e.target.value })} />
            <select aria-label="Temperature" value={r.temp} onChange={(e) => setRow(r.key, { temp: e.target.value as Row['temp'] })}>
              <option value="">No temp</option>
              <option value="hot">Hot</option>
              <option value="iced">Iced</option>
            </select>
            <input aria-label="Price in pesos" placeholder="Price ₱" inputMode="decimal" size={8} value={r.price} onChange={(e) => setRow(r.key, { price: e.target.value })} />
            {rows.length > 1 && <button type="button" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>Remove</button>}
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, { key: Math.max(...rows.map((r) => r.key)) + 1, size: '', temp: '', price: '' }])}>
          Add another price
        </button>
      </fieldset>

      {groups.length > 0 && (
        <fieldset>
          <legend>Add-ons offered</legend>
          <div className="row">
            {groups.map((g) => (
              <label key={g.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(g.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((x) => x !== g.id))}
                />{' '}
                {g.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <Err msg={error} />
      <div className="row">
        <button disabled={!valid}>Add item</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}
