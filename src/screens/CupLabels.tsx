import type { QueueItem } from '../db/db'

/** One label per drink: order number and name to claim by, item, size/temp, add-ons (sugar level), notes. Allergies print loud. */
export default function CupLabels({ items, onClose }: { items: QueueItem[]; onClose: () => void }) {
  const labels = items.flatMap((i) => Array.from({ length: i.qty }, (_, n) => ({ i, n })))
  return (
    <div className="card">
      <div className="print-area">
        {labels.map(({ i, n }) => (
          <div key={`${i.id}-${n}`} className="label">
            <strong>#{i.orderNumber} {i.orderLabel}</strong>
            <div><strong>{i.name}</strong> <small>{i.variantLabel}</small></div>
            {i.mods.length > 0 && <div>{i.mods.join(', ')}</div>}
            {i.notes.length > 0 && <div>{i.notes.join(' · ')}</div>}
            {i.allergy && <div className="allergy-note">⚠ ALLERGY: {i.allergy}</div>}
            <small>{n + 1} of {i.qty}</small>
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => window.print()}>Print labels</button>
      </div>
    </div>
  )
}
