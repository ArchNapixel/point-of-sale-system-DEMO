import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Item, Variant } from '../db/db'
import { getItemModifiers } from '../db/modifiers'
import { variantLabel } from '../db/menu'
import { buildLine, type CartLine } from '../lib/cart'
import { modifierUnitPrice, quote, type GroupWithMods } from '../lib/modifierPricing'
import { formatPeso } from '../lib/money'
import { newId } from '../lib/id'

export const NOTE_CHIPS = ['Less ice', 'Extra hot', 'Less sweet', 'Separate cup']

type PickerItem = Item & { variants: Variant[] }

/**
 * Chooses the size, add-ons and notes for one drink, with the price updating as you tap.
 * Used for a new line and to edit an existing one (pass `initial`).
 */
export default function ItemPicker({ item, initial, onConfirm, onCancel }: {
  item: PickerItem
  initial?: CartLine
  onConfirm: (line: CartLine) => void
  onCancel: () => void
}) {
  const groups = useLiveQuery(() => getItemModifiers(item.id), [item.id])
  const [variantId, setVariantId] = useState(
    (initial && item.variants.some((v) => v.id === initial.variantId) ? initial.variantId : item.variants[0].id),
  )
  const [picks, setPicks] = useState<Record<string, number>>(() =>
    Object.fromEntries((initial?.mods ?? []).map((m) => [m.modifierId, m.qty])),
  )
  const [notes, setNotes] = useState<string[]>(initial?.notes ?? [])
  const [allergy, setAllergy] = useState(initial?.allergy ?? '')
  const [askAllergy, setAskAllergy] = useState(!!initial?.allergy)
  if (!groups) return null

  const variant = item.variants.find((v) => v.id === variantId)!
  // Ignore remembered picks for options that no longer exist or were archived.
  const known = new Set(groups.flatMap((g) => g.modifiers.map((m) => m.id)))
  const selections = Object.entries(picks).filter(([id, q]) => q > 0 && known.has(id)).map(([modifierId, qty]) => ({ modifierId, qty }))
  const q = quote(variant, groups, selections)

  const choose = (g: GroupWithMods, id: string) => {
    const next = { ...picks }
    const selected = (next[id] ?? 0) > 0
    if (g.max === 1) for (const m of g.modifiers) delete next[m.id] // one choice: picking replaces
    if (selected) delete next[id]
    else next[id] = 1
    setPicks(next)
  }
  const step = (id: string, delta: number, max: number) => setPicks({ ...picks, [id]: Math.max(1, Math.min(max, (picks[id] ?? 1) + delta)) })
  const toggleNote = (n: string) => setNotes(notes.includes(n) ? notes.filter((x) => x !== n) : [...notes, n])

  const confirm = () => {
    if (initial?.allergy && !allergy.trim() && !window.confirm('Remove the allergy note from this drink?')) return
    onConfirm(buildLine(initial?.id ?? newId(), item, variant, variantLabel(variant), q, notes, askAllergy ? allergy : '', initial?.qty ?? 1))
  }

  return (
    <div className="picker card" role="dialog" aria-label={`Choose ${item.name}`}>
      <h3>{item.name}</h3>

      {item.variants.length > 1 && (
        <fieldset>
          <legend>Size</legend>
          <div className="choices">
            {item.variants.map((v) => (
              <button key={v.id} type="button" aria-pressed={v.id === variantId} onClick={() => setVariantId(v.id)}>
                {variantLabel(v)} <small>{formatPeso(v.price)}</small>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {groups.map((g) => (
        <fieldset key={g.id}>
          <legend>
            {g.name} <small>{g.min >= 1 ? 'required' : 'optional'}{g.max > 1 ? `, up to ${g.max}` : ''}</small>
          </legend>
          <div className="choices">
            {g.modifiers.map((m) => {
              const on = (picks[m.id] ?? 0) > 0
              const unit = modifierUnitPrice(m, variant.size)
              return (
                <span key={m.id} className="choice">
                  <button type="button" aria-pressed={on} disabled={m.soldOut} onClick={() => choose(g, m.id)}>
                    {m.name}{' '}
                    <small>
                      {m.soldOut ? 'sold out' : [unit > 0 ? `+${formatPeso(unit)}` : '', m.freeQty > 0 ? `${m.freeQty} free` : ''].filter(Boolean).join(' · ')}
                    </small>
                  </button>
                  {on && m.maxQty > 1 && (
                    <span className="stepper">
                      <button type="button" aria-label={`Less ${m.name}`} onClick={() => step(m.id, -1, m.maxQty)}>−</button>
                      <strong>{picks[m.id]}</strong>
                      <button type="button" aria-label={`More ${m.name}`} onClick={() => step(m.id, 1, m.maxQty)}>+</button>
                    </span>
                  )}
                </span>
              )
            })}
          </div>
        </fieldset>
      ))}

      <fieldset>
        <legend>Notes</legend>
        <div className="choices">
          {NOTE_CHIPS.map((n) => (
            <button key={n} type="button" aria-pressed={notes.includes(n)} onClick={() => toggleNote(n)}>{n}</button>
          ))}
          <button type="button" aria-pressed={askAllergy} className="allergy" onClick={() => setAskAllergy(!askAllergy)}>Allergy</button>
        </div>
        {askAllergy && (
          <input aria-label="Allergy details" placeholder="What is the allergy? (nuts, dairy…)" value={allergy} onChange={(e) => setAllergy(e.target.value)} autoFocus />
        )}
      </fieldset>

      {!q.ok && <ul className="hints">{q.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="row between">
        <strong className="live-price">{formatPeso(q.total)}</strong>
        <span className="row">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" disabled={!q.ok || (askAllergy && !allergy.trim())} onClick={confirm}>
            {initial ? 'Save changes' : 'Add to order'}
          </button>
        </span>
      </div>
    </div>
  )
}
