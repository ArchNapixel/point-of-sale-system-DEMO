import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Modifier, type ModifierGroup } from '../db/db'
import {
  createGroup, createModifier, setModifierActive, setModifierSoldOut, updateGroup, updateModifier,
} from '../db/modifiers'
import { can } from '../lib/roles'
import { formatPeso, parsePesos } from '../lib/money'
import { formatSizePrices, parseSizePrices } from '../lib/modifierPricing'
import { Err, useAction } from '../ui'

const num = (s: string) => (s.trim() === '' ? NaN : Number(s))
const digits = (s: string) => s.replace(/\D/g, '').slice(0, 3)
const ruleText = (g: ModifierGroup) =>
  `${g.min >= 1 ? 'Required' : 'Optional'}, ${g.min === g.max ? `pick ${g.max}` : g.min >= 1 ? `pick ${g.min} to ${g.max}` : `up to ${g.max}`}`

export default function Modifiers() {
  const { user } = useAuth()
  const groups = useLiveQuery(() => db.modifierGroups.toArray(), [])
  const modifiers = useLiveQuery(() => db.modifiers.toArray(), [])
  if (!user || !groups || !modifiers) return null
  const canEdit = can(user.role, 'editPrices')
  if (!canEdit && groups.length === 0) return null

  return (
    <>
      <h2>Add-ons</h2>
      {[...groups].sort((a, b) => a.sort - b.sort).map((g) => (
        <GroupCard
          key={g.id}
          group={g}
          mods={modifiers.filter((m) => m.groupId === g.id).sort((a, b) => a.sort - b.sort)}
          canEdit={canEdit}
          userId={user.id}
        />
      ))}
      {canEdit && <AddGroup />}
    </>
  )
}

function AddGroup() {
  const [name, setName] = useState('')
  const [min, setMin] = useState('0')
  const [max, setMax] = useState('1')
  const { error, run } = useAction()
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => createGroup({ name, min: num(min), max: num(max) }))) setName('')
  }
  return (
    <form onSubmit={add} className="row">
      <input aria-label="Add-on group name" placeholder="New group (Milk, Syrups, Sugar…)" value={name} onChange={(e) => setName(e.target.value)} />
      <label>Min <input aria-label="Minimum picks" inputMode="numeric" size={3} value={min} onChange={(e) => setMin(digits(e.target.value))} /></label>
      <label>Max <input aria-label="Maximum picks" inputMode="numeric" size={3} value={max} onChange={(e) => setMax(digits(e.target.value))} /></label>
      <button disabled={!name.trim()}>Add group</button>
      <small>Min 1 makes it required.</small>
      <Err msg={error} />
    </form>
  )
}

function GroupCard({ group, mods, canEdit, userId }: { group: ModifierGroup; mods: Modifier[]; canEdit: boolean; userId: string }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [min, setMin] = useState(String(group.min))
  const [max, setMax] = useState(String(group.max))
  const { error, run } = useAction()
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => updateGroup(group.id, { name, min: num(min), max: num(max) }))) setEditing(false)
  }
  return (
    <section className={`card ${group.active ? '' : 'archived-card'}`}>
      {editing ? (
        <form onSubmit={save} className="row">
          <input aria-label="Group name" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Min <input aria-label="Minimum picks" inputMode="numeric" size={3} value={min} onChange={(e) => setMin(digits(e.target.value))} /></label>
          <label>Max <input aria-label="Maximum picks" inputMode="numeric" size={3} value={max} onChange={(e) => setMax(digits(e.target.value))} /></label>
          <button disabled={!name.trim()}>Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <h3>
          {group.name} <small>{ruleText(group)}</small>{' '}
          {canEdit && <button onClick={() => setEditing(true)}>Edit</button>}{' '}
          {canEdit && <button onClick={() => setModifierActive('modifierGroups', group.id, !group.active)}>{group.active ? 'Archive' : 'Restore'}</button>}
        </h3>
      )}
      <Err msg={error} />
      <ul>
        {mods.map((m) => <ModifierRow key={m.id} mod={m} canEdit={canEdit} userId={userId} />)}
      </ul>
      {canEdit && group.active && <AddModifier groupId={group.id} userId={userId} />}
    </section>
  )
}

function priceText(m: Modifier) {
  const base = m.price === 0 ? 'no charge' : `+${formatPeso(m.price)}`
  const sizes = Object.entries(m.sizePrices).map(([s, c]) => `${s} +${formatPeso(c)}`).join(', ')
  const free = m.freeQty > 0 ? `first ${m.freeQty} free` : ''
  const qty = m.maxQty > 1 ? `up to ${m.maxQty}` : ''
  return [base, sizes && `(${sizes})`, free, qty].filter(Boolean).join(' · ')
}

function ModifierRow({ mod, canEdit, userId }: { mod: Modifier; canEdit: boolean; userId: string }) {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const { error, run } = useAction()
  const canSoldOut = !!user && can(user.role, 'markSoldOut')

  if (editing) {
    return (
      <li>
        <ModifierForm
          initial={mod}
          label="Save"
          onSubmit={async (input) => {
            if (await run(() => updateModifier(mod.id, input, userId))) setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
        <Err msg={error} />
      </li>
    )
  }
  return (
    <li className={mod.active ? '' : 'archived'}>
      <strong>{mod.name}</strong> <small>{priceText(mod)}</small> {mod.soldOut && <span className="badge">SOLD OUT</span>}{' '}
      {canSoldOut && mod.active && <button onClick={() => setModifierSoldOut(mod.id, !mod.soldOut)}>{mod.soldOut ? 'Mark available' : 'Mark sold out'}</button>}{' '}
      {canEdit && mod.active && <button onClick={() => setEditing(true)}>Edit</button>}{' '}
      {canEdit && <button onClick={() => setModifierActive('modifiers', mod.id, !mod.active)}>{mod.active ? 'Archive' : 'Restore'}</button>}
    </li>
  )
}

function AddModifier({ groupId, userId }: { groupId: string; userId: string }) {
  const { error, run } = useAction()
  const [key, setKey] = useState(0) // remounts the form to clear it after a successful add
  return (
    <>
      <ModifierForm
        key={key}
        label="Add option"
        onSubmit={async (input) => {
          if (await run(() => createModifier(groupId, input, userId))) setKey(key + 1)
        }}
      />
      <Err msg={error} />
    </>
  )
}

type Input = { name: string; price: number; sizePrices: Record<string, number>; freeQty: number; maxQty: number }

function ModifierForm({ initial, label, onSubmit, onCancel }: {
  initial?: Modifier; label: string; onSubmit: (i: Input) => void; onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [price, setPrice] = useState(initial ? String(initial.price / 100) : '0')
  const [sizes, setSizes] = useState(initial ? formatSizePrices(initial.sizePrices) : '')
  const [free, setFree] = useState(String(initial?.freeQty ?? 0))
  const [maxQty, setMaxQty] = useState(String(initial?.maxQty ?? 1))

  const cents = parsePesos(price)
  const sizePrices = parseSizePrices(sizes)
  const valid = name.trim() !== '' && cents !== null && sizePrices !== null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    onSubmit({ name, price: cents, sizePrices, freeQty: num(free), maxQty: num(maxQty) })
  }
  return (
    <form onSubmit={submit} className="row">
      <input aria-label="Option name" placeholder="Option (Oat milk, Vanilla…)" value={name} onChange={(e) => setName(e.target.value)} />
      <label>Price ₱ <input aria-label="Price in pesos" inputMode="decimal" size={6} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      <label>By size <input aria-label="Price by size" placeholder="12 oz: 30, 16 oz: 40" size={20} value={sizes} onChange={(e) => setSizes(e.target.value)} /></label>
      <label>First free <input aria-label="Free quantity" inputMode="numeric" size={3} value={free} onChange={(e) => setFree(digits(e.target.value))} /></label>
      <label>Max qty <input aria-label="Maximum quantity" inputMode="numeric" size={3} value={maxQty} onChange={(e) => setMaxQty(digits(e.target.value))} /></label>
      <button disabled={!valid}>{label}</button>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
    </form>
  )
}
