import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db } from '../db/db'
import { getSellableMenu } from '../db/menu'
import { payPractice } from '../db/practice'
import { addLine, cartCount, cartTotal, changeQty, emptyCart, lineTotal, removeLine, type Cart, type CartLine } from '../lib/cart'
import { formatPeso } from '../lib/money'
import { Err, useAction } from '../ui'
import ItemPicker from './ItemPicker'
import { PayPanel } from './Order'

type MenuItem = Awaited<ReturnType<typeof getSellableMenu>>[number]['items'][number]

/** A practice register for a new cashier: the real menu and the real payment rules, but nothing is saved as a sale. */
export default function Training() {
  const { user } = useAuth()
  const menu = useLiveQuery(getSellableMenu, [])
  const recent = useLiveQuery(() => db.practiceSales.orderBy('at').reverse().limit(5).toArray(), [])
  const [cart, setCart] = useState<Cart>(emptyCart())
  const [picking, setPicking] = useState<MenuItem | null>(null)
  const [catId, setCatId] = useState('')
  const [paying, setPaying] = useState(false)
  const [done, setDone] = useState<{ total: number; change: number } | null>(null)
  const { error } = useAction()
  if (!menu || !user || !recent) return null
  const category = menu.find((c) => c.id === catId) ?? menu[0]
  const add = (line: CartLine) => { setCart(addLine(cart, line)); setPicking(null); setDone(null) }

  return (
    <div className="order">
      <section>
        <h2>Training mode</h2>
        <p role="status"><strong>PRACTICE ONLY.</strong> Nothing here is a real sale: no invoice number, no stock, no money, and it never shows in a report.</p>
        {menu.length === 0 && <p>No items are on sale yet. The owner adds them on the Menu tab.</p>}
        <div className="cats">{menu.map((c) => <button key={c.id} aria-pressed={c.id === category?.id} onClick={() => setCatId(c.id)}>{c.name}</button>)}</div>
        <div className="items">
          {category?.items.map((i) => {
            const prices = i.variants.map((v) => v.price)
            const lo = Math.min(...prices)
            const hi = Math.max(...prices)
            return (
              <button key={i.id} className="item-btn" disabled={i.soldOut} onClick={() => setPicking(i)}>
                <strong>{i.name}</strong>
                <small>{i.soldOut ? 'SOLD OUT' : lo === hi ? formatPeso(lo) : `${formatPeso(lo)}–${formatPeso(hi)}`}</small>
              </button>
            )
          })}
        </div>
        {picking && <ItemPicker key={picking.id} item={picking} onConfirm={add} onCancel={() => setPicking(null)} />}
      </section>
      <aside className="cart card">
        <h3>Practice order</h3>
        {cart.lines.length === 0 && <p className="empty">Tap an item to start.</p>}
        <ul className="lines">
          {cart.lines.map((l) => (
            <li key={l.id}>
              <div className="line-main"><div><strong>{l.name}</strong> <small>{l.variantLabel}</small></div><strong>{formatPeso(lineTotal(l))}</strong></div>
              <div className="row">
                <button aria-label={`Less ${l.name}`} onClick={() => setCart(changeQty(cart, l.id, -1))}>−</button>
                <span className="qty">{l.qty}</span>
                <button aria-label={`More ${l.name}`} onClick={() => setCart(changeQty(cart, l.id, 1))}>+</button>
                <button onClick={() => setCart(removeLine(cart, l.id))}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        <div className="row between total"><span>{cartCount(cart)} item(s)</span><strong>{formatPeso(cartTotal(cart))}</strong></div>
        <div className="row">
          <button onClick={() => { setCart(emptyCart()); setPaying(false) }} disabled={cart.lines.length === 0}>Clear</button>
          <button className="primary" onClick={() => setPaying(true)} disabled={cart.lines.length === 0}>Practice payment</button>
        </div>
        <Err msg={error} />
        {paying && (
          <PayPanel
            practice
            total={cartTotal(cart)}
            onCancel={() => setPaying(false)}
            onPay={async (lines) => {
              const sale = await payPractice(user.id, cart, lines)
              setDone({ total: sale.total, change: sale.change })
              setCart(emptyCart())
              setPaying(false)
            }}
          />
        )}
        {done && (
          <div className="card" role="status">
            <p><strong>PRACTICE SALE</strong> of {formatPeso(done.total)}: not a real sale.</p>
            <p className="change">Change {formatPeso(done.change)}</p>
            <button onClick={() => setDone(null)}>Next practice order</button>
          </div>
        )}
        {recent.length > 0 && <small>{recent.length} recent practice sale(s) kept for your trainer.</small>}
      </aside>
    </div>
  )
}
