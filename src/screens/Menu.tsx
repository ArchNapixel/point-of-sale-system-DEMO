import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Category, type Item, type ModifierGroup, type Variant } from '../db/db'
import { createVariant, renameItem, setCategoryStation, setMenuActive, setSoldOut, updateVariant, variantLabel } from '../db/menu'
import { STATIONS, type Station } from '../lib/queue'
import { setItemGroup } from '../db/modifiers'
import AddMenuItem from './AddMenuItem'
import Modifiers from './Modifiers'
import { can } from '../lib/roles'
import { formatPeso, parsePesos } from '../lib/money'
import { Err, useAction } from '../ui'

type Temp = '' | 'hot' | 'iced'

export default function Menu() {
  const { user } = useAuth()
  const categories = useLiveQuery(() => db.categories.toArray(), [])
  const items = useLiveQuery(() => db.items.toArray(), [])
  const variants = useLiveQuery(() => db.variants.toArray(), [])
  const groups = useLiveQuery(() => db.modifierGroups.toArray(), [])
  const [adding, setAdding] = useState(false)
  if (!user || !categories || !items || !variants || !groups) return null
  const canEdit = can(user.role, 'editPrices')

  return (
    <>
      <div className="row between">
        <h2>Menu</h2>
        {canEdit && !adding && <button className="primary" onClick={() => setAdding(true)}>Add menu item</button>}
      </div>
      {adding && <AddMenuItem userId={user.id} onDone={() => setAdding(false)} />}
      {!canEdit && <p>Tap an item to mark it sold out or available again.</p>}
      {canEdit && categories.length === 0 && !adding && <p>Your menu is empty. Tap "Add menu item" to start.</p>}
      {[...categories].sort((a, b) => a.sort - b.sort).map((c) => (
        <CategoryCard
          key={c.id}
          category={c}
          items={items.filter((i) => i.categoryId === c.id).sort((a, b) => a.name.localeCompare(b.name))}
          variants={variants}
          groups={groups.filter((g) => g.active).sort((a, b) => a.sort - b.sort)}
          canEdit={canEdit}
          userId={user.id}
        />
      ))}
      {categories.length === 0 && !canEdit && <p>The owner hasn't added a menu yet.</p>}
      <Modifiers />
    </>
  )
}

function CategoryCard({ category, items, variants, groups, canEdit, userId }: {
  category: Category; items: Item[]; variants: Variant[]; groups: ModifierGroup[]; canEdit: boolean; userId: string
}) {
  return (
    <section className={`card ${category.active ? '' : 'archived-card'}`}>
      <h3>
        {category.name}{' '}
        {canEdit && (
          <select aria-label={`${category.name} is prepared at`} value={category.station ?? 'bar'} onChange={(e) => setCategoryStation(category.id, e.target.value as Station)}>
            {STATIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}{' '}
        {canEdit && (
          <button onClick={() => setMenuActive('categories', category.id, !category.active)}>
            {category.active ? 'Archive' : 'Restore'}
          </button>
        )}
      </h3>
      {items.map((i) => (
        <ItemRow key={i.id} item={i} variants={variants.filter((v) => v.itemId === i.id).sort((a, b) => a.price - b.price)} groups={groups} canEdit={canEdit} userId={userId} />
      ))}
    </section>
  )
}

function ItemRow({ item, variants, groups, canEdit, userId }: {
  item: Item; variants: Variant[]; groups: ModifierGroup[]; canEdit: boolean; userId: string
}) {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(item.name)
  const { error, run } = useAction()
  const canSoldOut = !!user && can(user.role, 'markSoldOut')
  const active = variants.filter((v) => v.active)

  return (
    <div className={`item ${item.active ? '' : 'archived'}`}>
      <div className="row">
        {editing ? (
          <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => renameItem(item.id, name))) setEditing(false) }}>
            <input aria-label="Item name" value={name} onChange={(e) => setName(e.target.value)} />
            <button disabled={!name.trim()}>Save</button>
            <button type="button" onClick={() => { setEditing(false); setName(item.name) }}>Cancel</button>
          </form>
        ) : (
          <strong>{item.name}</strong>
        )}
        {item.soldOut && <span className="badge">SOLD OUT</span>}
        {canSoldOut && item.active && (
          <button onClick={() => setSoldOut(item.id, !item.soldOut)}>{item.soldOut ? 'Mark available' : 'Mark sold out'}</button>
        )}
        {canEdit && !editing && <button onClick={() => setEditing(true)}>Rename</button>}
        {canEdit && <button onClick={() => setMenuActive('items', item.id, !item.active)}>{item.active ? 'Archive' : 'Restore'}</button>}
      </div>
      <Err msg={error} />
      {item.active && active.length === 0 && <p><small>No price yet, so this item can't be sold.</small></p>}
      <ul>
        {variants.map((v) => (
          <VariantRow key={v.id} variant={v} canEdit={canEdit} userId={userId} />
        ))}
      </ul>
      {canEdit && item.active && <AddVariant itemId={item.id} userId={userId} />}
      {canEdit && item.active && groups.length > 0 && (
        <p className="row">
          <small>Add-ons offered:</small>
          {groups.map((g) => (
            <label key={g.id}>
              <input
                type="checkbox"
                checked={(item.groupIds ?? []).includes(g.id)}
                onChange={(e) => setItemGroup(item.id, g.id, e.target.checked)}
              />{' '}
              {g.name}
            </label>
          ))}
        </p>
      )}
    </div>
  )
}

function VariantRow({ variant, canEdit, userId }: { variant: Variant; canEdit: boolean; userId: string }) {
  const [editing, setEditing] = useState(false)
  const [price, setPrice] = useState(String(variant.price / 100))
  const { error, run } = useAction()
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const c = parsePesos(price)
    if (c === null) return
    if (await run(() => updateVariant(variant.id, { size: variant.size, temp: variant.temp, price: c }, userId))) setEditing(false)
  }
  return (
    <li className={variant.active ? '' : 'archived'}>
      {variantLabel(variant)} — {editing ? (
        <form onSubmit={save} className="row inline">
          <input aria-label="Price in pesos" inputMode="decimal" size={7} value={price} onChange={(e) => setPrice(e.target.value)} />
          <button disabled={parsePesos(price) === null}>Save</button>
          <button type="button" onClick={() => { setEditing(false); setPrice(String(variant.price / 100)) }}>Cancel</button>
        </form>
      ) : (
        <>
          <strong>{formatPeso(variant.price)}</strong>{' '}
          {canEdit && variant.active && <button onClick={() => setEditing(true)}>Change price</button>}{' '}
          {canEdit && <button onClick={() => setMenuActive('variants', variant.id, !variant.active)}>{variant.active ? 'Archive' : 'Restore'}</button>}
        </>
      )}
      <Err msg={error} />
    </li>
  )
}

function AddVariant({ itemId, userId }: { itemId: string; userId: string }) {
  const [size, setSize] = useState('')
  const [temp, setTemp] = useState<Temp>('')
  const [price, setPrice] = useState('')
  const { error, run } = useAction()
  const cents = parsePesos(price)
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (cents === null) return
    if (await run(() => createVariant(itemId, { size, temp: temp || undefined, price: cents }, userId))) {
      setSize('')
      setPrice('')
    }
  }
  return (
    <form onSubmit={add} className="row">
      <input aria-label="Size" placeholder="Size (16 oz) or blank" size={14} value={size} onChange={(e) => setSize(e.target.value)} />
      <select aria-label="Temperature" value={temp} onChange={(e) => setTemp(e.target.value as Temp)}>
        <option value="">No temp</option>
        <option value="hot">Hot</option>
        <option value="iced">Iced</option>
      </select>
      <input aria-label="Price in pesos" placeholder="Price ₱" inputMode="decimal" size={8} value={price} onChange={(e) => setPrice(e.target.value)} />
      <button disabled={cents === null}>Add price</button>
      <Err msg={error} />
    </form>
  )
}
