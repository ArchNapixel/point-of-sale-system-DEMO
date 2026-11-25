import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Ingredient } from '../db/db'
import { setPar } from '../db/purchasing'
import { setCup } from '../db/counts'
import { addUnit, createIngredient, renameIngredient, setIngredientActive, setUnitActive, setUnitFactor } from '../db/ingredients'
import { BASE_UNITS, toBase, type BaseUnit } from '../lib/units'
import { can } from '../lib/roles'
import { Err, useAction } from '../ui'

/** Ingredients and how their units convert. Stock levels and recipes build on this (3B, 3C). */
export default function Ingredients() {
  const { user } = useAuth()
  const list = useLiveQuery(() => db.ingredients.toArray().then((l) => l.sort((a, b) => a.name.localeCompare(b.name))), [])
  const [name, setName] = useState('')
  const [base, setBase] = useState<BaseUnit>('g')
  const { error, run } = useAction()
  if (!list || !user) return null
  const canEdit = can(user.role, 'editStock')
  return (
    <section>
      <h2>Ingredients</h2>
      {canEdit ? (
        <form className="card row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => createIngredient(name, base, user.id))) setName('') }}>
          <input aria-label="Ingredient name" placeholder="Espresso beans" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Counted in{' '}
            <select value={base} onChange={(e) => setBase(e.target.value as BaseUnit)}>{BASE_UNITS.map((u) => <option key={u}>{u}</option>)}</select>
          </label>
          <button className="primary" disabled={!name.trim()}>Add ingredient</button>
        </form>
      ) : <p>Only a supervisor or the owner edits ingredients.</p>}
      <Err msg={error} />
      {list.length === 0 && <p className="empty">No ingredients yet. Add the first one above.</p>}
      {list.map((i) => <IngredientCard key={i.id} ing={i} canEdit={canEdit} userId={user.id} />)}
    </section>
  )
}

function IngredientCard({ ing, canEdit, userId }: { ing: Ingredient; canEdit: boolean; userId: string }) {
  const [unit, setUnit] = useState('')
  const [factor, setFactor] = useState('')
  const [rename, setRename] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ unit: string; factor: string } | null>(null)
  const [parQty, setParQty] = useState('')
  const [parUnit, setParUnit] = useState('')
  const [try_, setTry] = useState({ qty: '1', unit: '' })
  const { error, run } = useAction()
  const tryUnit = try_.unit || ing.units.find((u) => u.active)?.name || ing.baseUnit
  let preview = ''
  try { preview = `${try_.qty} ${tryUnit} = ${toBase(ing, Number(try_.qty), tryUnit)} ${ing.baseUnit}` } catch { /* not a number yet */ }

  return (
    <div className={`card ${ing.active ? '' : 'archived-card'}`}>
      <h3>
        {rename === null ? ing.name : (
          <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => renameIngredient(ing.id, rename, userId))) setRename(null) }}>
            <input aria-label="New name" value={rename} onChange={(e) => setRename(e.target.value)} />
            <button>Save</button> <button type="button" onClick={() => setRename(null)}>Cancel</button>
          </form>
        )}{' '}
        <small>counted in {ing.baseUnit}</small>{' '}
        {canEdit && rename === null && (
          <>
            <button onClick={() => setRename(ing.name)}>Rename</button>{' '}
            <button onClick={() => run(() => setIngredientActive(ing.id, !ing.active, userId))}>{ing.active ? 'Archive' : 'Restore'}</button>
          </>
        )}
      </h3>
      <ul className="lines">
        {ing.units.map((u) => (
          <li key={u.name} className={`row between ${u.active ? '' : 'archived'}`}>
            <span>
              1 {u.name} = {edit?.unit === u.name ? (
                <input aria-label={`${u.name} factor`} inputMode="decimal" size={8} value={edit.factor} onChange={(e) => setEdit({ unit: u.name, factor: e.target.value })} />
              ) : u.factor} {ing.baseUnit}
            </span>
            {canEdit && (
              <span className="row">
                {edit?.unit === u.name ? (
                  <button onClick={async () => { if (await run(() => setUnitFactor(ing.id, u.name, Number(edit.factor), userId))) setEdit(null) }}>Save</button>
                ) : (
                  <button onClick={() => setEdit({ unit: u.name, factor: String(u.factor) })}>Change</button>
                )}
                <button onClick={() => run(() => setUnitActive(ing.id, u.name, !u.active, userId))}>{u.active ? 'Switch off' : 'Switch on'}</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => addUnit(ing.id, unit, Number(factor), userId))) { setUnit(''); setFactor('') } }}>
          1 <input aria-label="New unit name" placeholder="pump" size={10} value={unit} onChange={(e) => setUnit(e.target.value)} /> =
          <input aria-label="Base units per unit" inputMode="decimal" placeholder="10" size={8} value={factor} onChange={(e) => setFactor(e.target.value)} /> {ing.baseUnit}
          <button disabled={!unit.trim() || !factor}>Add unit</button>
        </form>
      )}
      {canEdit && (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await run(() => setPar(ing.id, Number(parQty), parUnit || ing.baseUnit, userId)) }}>
          <small>Par level (keep this much on hand):</small>
          <input aria-label="Par quantity" size={6} inputMode="decimal" placeholder={ing.par ? String(ing.par) : '0'} value={parQty} onChange={(e) => setParQty(e.target.value)} />
          <select aria-label="Par unit" value={parUnit || ing.baseUnit} onChange={(e) => setParUnit(e.target.value)}>
            {[ing.baseUnit as string, ...ing.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>)}
          </select>
          <button disabled={!parQty}>Set par</button>
          {ing.par ? <small>now {ing.par} {ing.baseUnit}</small> : null}
        </form>
      )}
      <div className="row">
        {canEdit && <label><input type="checkbox" checked={!!ing.cup} onChange={(e) => run(() => setCup(ing.id, e.target.checked, userId))} /> counts one drink (cups)</label>}
        <small>Try it:</small>
        <input aria-label="Quantity to convert" size={6} inputMode="decimal" value={try_.qty} onChange={(e) => setTry({ ...try_, qty: e.target.value })} />
        <select aria-label="Unit to convert" value={tryUnit} onChange={(e) => setTry({ ...try_, unit: e.target.value })}>
          {[ing.baseUnit as string, ...ing.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>)}
        </select>
        <small>{preview}</small>
      </div>
      <Err msg={error} />
    </div>
  )
}
