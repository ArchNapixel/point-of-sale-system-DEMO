import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type Ingredient } from '../db/db'
import { variantLabel } from '../db/menu'
import { currentRecipe, recipeHistory, saveRecipe, type RecipeKind } from '../db/recipes'
import { formatQty, toBase } from '../lib/units'
import type { RecipeLine } from '../lib/recipes'
import { Err, useAction } from '../ui'

type Row = { ingredientId: string; qty: string; unit: string; op: RecipeLine['op']; withId: string; withQty: string; carry: boolean }
const blankRow = (op: Row['op']): Row => ({ ingredientId: '', qty: '', unit: '', op, withId: '', withQty: '', carry: false })

/** Recipes per size (what a sale uses) and per add-on (what it adds, removes or swaps). Each save is a new version. */
export default function Recipes() {
  const { user } = useAuth()
  const data = useLiveQuery(async () => {
    const [items, variants, modifiers, groups, ingredients] = await Promise.all([
      db.items.filter((i) => i.active).toArray(), db.variants.filter((v) => v.active).toArray(), db.modifiers.filter((m) => m.active).toArray(),
      db.modifierGroups.toArray(), db.ingredients.toArray(),
    ])
    const recipes = await db.recipes.toArray()
    const latest = new Map<string, (typeof recipes)[number]>()
    for (const r of recipes) { const k = `${r.kind}:${r.refId}`; if (!latest.has(k) || latest.get(k)!.version < r.version) latest.set(k, r) }
    return { items, variants, modifiers, groups, ingredients, latest }
  }, [])
  const [open, setOpen] = useState<{ kind: RecipeKind; refId: string; title: string } | null>(null)
  if (!data || !user) return null
  const byId = new Map(data.ingredients.map((i) => [i.id, i]))
  const summary = (kind: RecipeKind, id: string) => {
    const r = data.latest.get(`${kind}:${id}`)
    if (!r) return <small>no recipe yet</small>
    return <small>v{r.version}: {r.lines.map((l) => {
      const ing = byId.get(l.ingredientId)
      const q = ing ? formatQty(ing, l.qty) : '?'
      const what = l.op === 'add' ? `${l.qty > 0 ? '+' : ''}${q} ${ing?.name}` : l.op === 'remove' ? `no ${ing?.name}` : `${byId.get(l.withIngredientId ?? '')?.name} instead of ${ing?.name}`
      return what + (l.when === 'carry' ? ' (takeout)' : '')
    }).join(', ')}</small>
  }
  const active = data.ingredients.filter((i) => i.active)

  return (
    <section>
      <h2>Recipes</h2>
      {active.length === 0 && <p>Add ingredients first.</p>}
      {open && <RecipeEditor key={`${open.kind}:${open.refId}`} {...open} ingredients={active} userId={user.id} onDone={() => setOpen(null)} />}
      <h3>Drinks and food</h3>
      {data.items.length === 0 && <p className="empty">No menu items yet.</p>}
      {data.items.sort((a, b) => a.name.localeCompare(b.name)).map((i) => (
        <div key={i.id} className="card">
          <strong>{i.name}</strong>
          {data.variants.filter((v) => v.itemId === i.id).map((v) => (
            <div key={v.id} className="row between">
              <span>{variantLabel(v)} {summary('variant', v.id)}</span>
              <button onClick={() => setOpen({ kind: 'variant', refId: v.id, title: `${i.name} · ${variantLabel(v)}` })}>Recipe</button>
            </div>
          ))}
        </div>
      ))}
      <h3>Add-ons</h3>
      <div className="card">
        {data.modifiers.length === 0 && <p className="empty">No add-ons yet.</p>}
        {data.modifiers.map((m) => (
          <div key={m.id} className="row between">
            <span>{m.name} <small>({data.groups.find((g) => g.id === m.groupId)?.name})</small> {summary('modifier', m.id)}</span>
            <button onClick={() => setOpen({ kind: 'modifier', refId: m.id, title: `Add-on: ${m.name}` })}>Recipe</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function RecipeEditor({ kind, refId, title, ingredients, userId, onDone }: {
  kind: RecipeKind; refId: string; title: string; ingredients: Ingredient[]; userId: string; onDone: () => void
}) {
  const cur = useLiveQuery(async () => ({ r: await currentRecipe(kind, refId), history: await recipeHistory(kind, refId) }), [kind, refId])
  const [rows, setRows] = useState<Row[] | null>(null)
  const { error, run } = useAction()
  if (!cur) return null
  const ing = (id: string) => ingredients.find((i) => i.id === id)
  const shown: Row[] = rows ?? (cur.r ? cur.r.lines.map((l) => ({
    ingredientId: l.ingredientId, qty: l.qty ? String(l.qty) : '', unit: ing(l.ingredientId)?.baseUnit ?? '', op: l.op,
    withId: l.withIngredientId ?? '', withQty: l.withQty ? String(l.withQty) : '', carry: l.when === 'carry',
  })) : [blankRow('add')])
  const set = (i: number, patch: Partial<Row>) => setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = () =>
    run(async () => {
      const lines: RecipeLine[] = shown.map((r) => {
        const a = ing(r.ingredientId)
        if (!a) throw new Error('Pick an ingredient for every row')
        const qty = r.qty.trim() === '' ? 0 : toBase(a, Number(r.qty), r.unit || a.baseUnit)
        const w = ing(r.withId)
        return {
          ingredientId: a.id, qty, op: r.op, when: r.carry ? 'carry' : 'always',
          ...(r.op === 'replace' && { withIngredientId: r.withId || undefined, ...(r.withQty.trim() && w && { withQty: toBase(w, Number(r.withQty), w.baseUnit) }) }),
        }
      })
      await saveRecipe(kind, refId, lines, userId)
      setRows(null)
      onDone()
    })

  return (
    <div className="card">
      <h3>{title} {cur.r && <small>(now v{cur.r.version})</small>}</h3>
      <small>
        {kind === 'variant'
          ? 'What one sale uses. Amounts are per drink. Tick "takeout only" for the cup, lid and straw.'
          : 'What this add-on changes. Add = extra per unit picked. No = take it out. Instead = swap one ingredient for another.'}
      </small>
      {shown.map((r, i) => {
        const a = ing(r.ingredientId)
        return (
          <div key={i} className="row">
            {kind === 'modifier' && (
              <select aria-label="Change" value={r.op} onChange={(e) => set(i, { op: e.target.value as Row['op'] })}>
                <option value="add">Add</option><option value="remove">No / less</option><option value="replace">Instead</option>
              </select>
            )}
            <select aria-label="Ingredient" value={r.ingredientId} onChange={(e) => set(i, { ingredientId: e.target.value, unit: '' })}>
              <option value="">Ingredient</option>{ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <input aria-label="Amount" inputMode="decimal" size={6} placeholder={r.op === 'add' ? 'Amount' : 'All'} value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} />
            <select aria-label="Unit" value={r.unit || a?.baseUnit || ''} onChange={(e) => set(i, { unit: e.target.value })}>
              {a ? [a.baseUnit as string, ...a.units.filter((u) => u.active).map((u) => u.name)].map((u) => <option key={u}>{u}</option>) : <option value="">unit</option>}
            </select>
            {r.op === 'replace' && (
              <>
                with
                <select aria-label="Replacement ingredient" value={r.withId} onChange={(e) => set(i, { withId: e.target.value })}>
                  <option value="">Ingredient</option>{ingredients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <input aria-label="Replacement amount" inputMode="decimal" size={6} placeholder="same" value={r.withQty} onChange={(e) => set(i, { withQty: e.target.value })} />
                <small>{ing(r.withId)?.baseUnit}</small>
              </>
            )}
            <label><input type="checkbox" checked={r.carry} onChange={(e) => set(i, { carry: e.target.checked })} /> takeout only</label>
            <button onClick={() => setRows(shown.filter((_, j) => j !== i))} aria-label="Remove row">✕</button>
          </div>
        )
      })}
      <div className="row">
        <button onClick={() => setRows([...shown, blankRow('add')])}>Add row</button>
        <button className="primary" onClick={save}>Save as new version</button>
        <button onClick={onDone}>Close</button>
      </div>
      <Err msg={error} />
      {cur.history.length > 1 && <small>Earlier versions kept: {cur.history.slice(1).map((h) => `v${h.version} (${new Date(h.at).toLocaleDateString('en-PH')})`).join(', ')}</small>}
    </div>
  )
}
