import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type User } from '../db/db'
import { getSellContext } from '../db/shifts'
import { getSellableMenu } from '../db/menu'
import { discardHeld, holdCart, listHeld, resumeHeld } from '../db/carts'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { payCash } from '../db/orders'
import { parsePesos, pesos } from '../lib/money'
import {
  ORDER_TYPES, addLine, buildLine, cartCount, cartTotal, changeQty, duplicateLine, emptyCart, lineTotal, removeLine, replaceLine,
  type Cart, type CartLine, type OrderType,
} from '../lib/cart'
import { quote } from '../lib/modifierPricing'
import { formatPeso } from '../lib/money'
import { newId } from '../lib/id'
import { variantLabel } from '../db/menu'
import { Err, useAction } from '../ui'
import ItemPicker from './ItemPicker'

type MenuItem = Awaited<ReturnType<typeof getSellableMenu>>[number]['items'][number]

const cartKey = (terminalId: string) => `pos-cart-${terminalId}` // autosave so a crash or refresh keeps the cart

function loadCart(terminalId: string): Cart {
  try {
    const raw = localStorage.getItem(cartKey(terminalId))
    return raw ? { ...emptyCart(), ...JSON.parse(raw) } : emptyCart()
  } catch {
    return emptyCart()
  }
}

export default function Order() {
  const { user } = useAuth()
  const terminals = useLiveQuery(() => db.terminals.toArray().then((t) => t.filter((x) => x.active)), [])
  const terminal = terminals && resolveTerminal(terminals, localStorage.getItem(DEVICE_KEY))
  const ctx = useLiveQuery(async () => (terminal ? (await getSellContext(terminal.id)) ?? false : undefined), [terminal?.id])
  const cashier = useLiveQuery(async () => (ctx ? db.users.get(ctx.shift.cashierId) : undefined), [ctx && ctx.shift.cashierId])
  if (!user || !terminals) return null
  if (!terminal) return <p>No terminal yet. The owner adds one in Setup.</p>
  if (ctx === undefined) return null
  if (!ctx) return <p>Selling needs an open business day and an open shift on this terminal. Open them on the Shift tab.</p>
  if (ctx.shift.cashierId !== user.id) {
    return <p>This drawer belongs to {cashier?.name ?? 'another cashier'}. Two people never share a drawer: they hand over, or you open a shift on another terminal.</p>
  }
  return <OrderScreen terminalId={terminal.id} shiftId={ctx.shift.id} user={user} />
}

/** Cash tendered + change. The key is made once per open panel, so a double tap can't save two payments. */
function CashPanel({ total, onPay, onCancel }: { total: number; onPay: (tendered: number, key: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState('')
  const [key] = useState(newId)
  const [busy, setBusy] = useState(false)
  const { error, run } = useAction()
  const tendered = parsePesos(text)
  const change = tendered === null ? null : tendered - total
  const set = (c: number) => setText(String(c / 100))
  return (
    <div className="card">
      <div className="row between"><span>Total</span><strong>{formatPeso(total)}</strong></div>
      <div className="row">
        <button onClick={() => set(total)}>Exact</button>
        {[100, 500, 1000].map((p) => <button key={p} onClick={() => set(pesos(p))}>{formatPeso(pesos(p)).replace('.00', '')}</button>)}
      </div>
      <input aria-label="Cash tendered" inputMode="decimal" placeholder="Cash tendered" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <p className="change" style={{ fontSize: '2rem' }}>
        {change === null ? 'Change —' : change < 0 ? `Short ${formatPeso(-change)}` : `Change ${formatPeso(change)}`}
      </p>
      <Err msg={error} />
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button
          className="primary"
          disabled={busy || change === null || change < 0}
          onClick={async () => { setBusy(true); await run(() => onPay(tendered!, key)); setBusy(false) }}
        >
          Confirm payment
        </button>
      </div>
    </div>
  )
}

function OrderScreen({ terminalId, shiftId, user }: { terminalId: string; shiftId: string; user: User }) {
  const [cart, setCart] = useState<Cart>(() => loadCart(terminalId))
  const [history, setHistory] = useState<Cart[]>([]) // carts before each change to the lines, for Undo
  const [picking, setPicking] = useState<{ item: MenuItem; initial?: CartLine } | null>(null)
  const [catId, setCatId] = useState('')
  const [paying, setPaying] = useState(false)
  const [done, setDone] = useState<{ number: number; change: number } | null>(null)
  const menu = useLiveQuery(getSellableMenu, [])
  const held = useLiveQuery(() => listHeld(terminalId), [terminalId])
  const { error, run } = useAction()

  useEffect(() => {
    localStorage.setItem(cartKey(terminalId), JSON.stringify(cart))
  }, [cart, terminalId])

  if (!menu || !held) return null
  const category = menu.find((c) => c.id === catId) ?? menu[0]

  const commit = (next: Cart) => {
    setHistory((h) => [...h.slice(-19), cart])
    setCart(next)
  }
  const undo = () => {
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory(history.slice(0, -1))
    setCart({ ...cart, lines: prev.lines }) // only the lines roll back; name and order type stay as typed
  }

  const tapItem = (item: MenuItem) => {
    // One price and no add-ons: add straight away. Anything else opens the chooser.
    if (item.variants.length === 1 && (item.groupIds ?? []).length === 0) {
      const v = item.variants[0]
      commit(addLine(cart, buildLine(newId(), item, v, variantLabel(v), quote(v, [], []), [], '')))
    } else {
      setPicking({ item })
    }
  }
  const confirmPick = (line: CartLine) => {
    commit(picking?.initial ? replaceLine(cart, picking.initial.id, line) : addLine(cart, line))
    setPicking(null)
  }
  const editLine = (l: CartLine) => {
    const item = menu.flatMap((c) => c.items).find((i) => i.id === l.itemId)
    if (!item) return run(() => Promise.reject(new Error(`${l.name} is no longer on the menu. Remove the line and add it again.`)))
    setPicking({ item, initial: l })
  }

  const hold = () =>
    run(async () => {
      await holdCart(terminalId, shiftId, user.id, cart)
      setCart(emptyCart())
      setHistory([])
    })
  const pickUp = (id: string) =>
    run(async () => {
      if (cartCount(cart) > 0) throw new Error('Hold or clear the current cart first')
      setCart(await resumeHeld(id))
      setHistory([])
    })

  const setType = (orderType: OrderType) => setCart({ ...cart, orderType })

  return (
    <div className="order">
      <section>
        <h2>Order</h2>
        {menu.length === 0 && <p>No items are on sale yet. The owner adds them on the Menu tab.</p>}
        <div className="cats">
          {menu.map((c) => (
            <button key={c.id} aria-pressed={c.id === category?.id} onClick={() => setCatId(c.id)}>{c.name}</button>
          ))}
        </div>
        <div className="items">
          {category?.items.map((i) => {
            const prices = i.variants.map((v) => v.price)
            const lo = Math.min(...prices)
            const hi = Math.max(...prices)
            return (
              <button key={i.id} className="item-btn" disabled={i.soldOut} onClick={() => tapItem(i)}>
                <strong>{i.name}</strong>
                <small>{i.soldOut ? 'SOLD OUT' : lo === hi ? formatPeso(lo) : `${formatPeso(lo)}–${formatPeso(hi)}`}</small>
              </button>
            )
          })}
        </div>
        {picking && (
          <ItemPicker key={picking.initial?.id ?? picking.item.id} item={picking.item} initial={picking.initial} onConfirm={confirmPick} onCancel={() => setPicking(null)} />
        )}
      </section>

      <aside className="cart card">
        <div className="seg">
          {ORDER_TYPES.map((t) => (
            <button key={t.id} aria-pressed={cart.orderType === t.id} onClick={() => setType(t.id)}>{t.label}</button>
          ))}
        </div>
        {cart.orderType === 'dine-in' ? (
          <input aria-label="Table number" placeholder="Table number" value={cart.table} onChange={(e) => setCart({ ...cart, table: e.target.value })} />
        ) : (
          <input aria-label="Customer name" placeholder="Customer name (add last initial)" value={cart.name} onChange={(e) => setCart({ ...cart, name: e.target.value })} />
        )}
        <small>The order number is given when the order is paid.</small>

        {cart.lines.length === 0 && <p className="empty">Tap an item to start the order.</p>}
        <ul className="lines">
          {cart.lines.map((l) => (
            <li key={l.id}>
              <div className="line-main">
                <div>
                  <strong>{l.name}</strong> <small>{l.variantLabel}</small>
                  {l.mods.length > 0 && <div><small>{l.mods.map((m) => `${m.name}${m.qty > 1 ? ` ×${m.qty}` : ''}`).join(', ')}</small></div>}
                  {l.notes.length > 0 && <div><small>{l.notes.join(' · ')}</small></div>}
                  {l.allergy && <div className="allergy-note">⚠ ALLERGY: {l.allergy}</div>}
                </div>
                <strong>{formatPeso(lineTotal(l))}</strong>
              </div>
              <div className="row">
                <button aria-label={`Less ${l.name}`} onClick={() => commit(changeQty(cart, l.id, -1))}>−</button>
                <span className="qty">{l.qty}</span>
                <button aria-label={`More ${l.name}`} onClick={() => commit(changeQty(cart, l.id, 1))}>+</button>
                <button onClick={() => editLine(l)}>Edit</button>
                <button onClick={() => commit(duplicateLine(cart, l.id, newId()))}>Duplicate</button>
                <button onClick={() => commit(removeLine(cart, l.id))}>Remove</button>
              </div>
            </li>
          ))}
        </ul>

        <div className="row between total">
          <span>{cartCount(cart)} item{cartCount(cart) === 1 ? '' : 's'}</span>
          <strong>{formatPeso(cartTotal(cart))}</strong>
        </div>
        <div className="row">
          <button onClick={undo} disabled={history.length === 0}>Undo</button>
          <button onClick={() => commit({ ...cart, lines: [] })} disabled={cart.lines.length === 0}>Clear</button>
          <button onClick={hold} disabled={cart.lines.length === 0}>Hold</button>
          <button className="primary" onClick={() => setPaying(true)} disabled={cart.lines.length === 0}>Take payment</button>
        </div>
        <Err msg={error} />
        {paying && (
          <CashPanel
            total={cartTotal(cart)}
            onCancel={() => setPaying(false)}
            onPay={async (tendered, key) => {
              const { order, payment } = await payCash(terminalId, user.id, cart, tendered, key)
              setCart(emptyCart())
              setHistory([])
              setPaying(false)
              setDone({ number: order.number, change: payment.tendered - payment.amount })
            }}
          />
        )}
        {done && (
          <div className="card" role="status">
            <p>Order #{done.number} paid</p>
            <p className="change">Change {formatPeso(done.change)}</p>
            <button onClick={() => setDone(null)}>Next order</button>
          </div>
        )}

        {held.length > 0 && (
          <div>
            <h4>Held ({held.length})</h4>
            <ul className="lines">
              {held.map((h) => (
                <li key={h.id} className="row between">
                  <span>{h.label} <small>{cartCount(h.cart)} items · {formatPeso(cartTotal(h.cart))}</small></span>
                  <span className="row">
                    <button onClick={() => pickUp(h.id)}>Pick up</button>
                    <button onClick={() => run(() => discardHeld(h.id))}>Discard</button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}
