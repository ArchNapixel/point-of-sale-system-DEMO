import { useLiveQuery } from 'dexie-react-hooks'
import { marginReport } from '../db/costs'
import { formatPeso } from '../lib/money'

/** Cost per drink and margin, from the current recipes and the weighted average cost of what was actually bought. */
export default function Costs() {
  const data = useLiveQuery(marginReport, [])
  if (!data) return null
  const low = data.rows.filter((r) => r.below)
  const pct = (m: { pct: number } | null) => (m ? `${m.pct}%` : '—')
  return (
    <section>
      <h2>Cost and margin</h2>
      <small>Margin is worked out on the price without VAT. Target {data.target}%. Change it in Settings.</small>
      {low.length > 0 && <p role="status"><strong>Under target: {low.map((r) => r.name).join(', ')}</strong></p>}
      {data.rows.length === 0 && <p className="empty">No menu items yet.</p>}
      <table className="compare">
        <thead><tr><th>Drink</th><th>Price</th><th>Cost dine-in</th><th>Cost to go</th><th>Margin dine-in</th><th>Margin to go</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.variantId} className={r.below ? 'flag' : ''}>
              <th>{r.name}</th>
              <td>{formatPeso(r.price)}</td>
              {!r.hasRecipe ? <td colSpan={4}>no recipe yet</td> : !r.known ? <td colSpan={4}>cost unknown: no price yet for {r.toGo?.unknown.join(', ')}</td> : (
                <>
                  <td>{formatPeso(r.dineIn!.cost)}</td><td>{formatPeso(r.toGo!.cost)}</td><td>{pct(r.dineIn)}</td><td>{pct(r.toGo)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
