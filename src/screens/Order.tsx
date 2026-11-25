import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth'
import { db, type User } from '../db/db'
import { expectedCash, getSellContext } from '../db/shifts'
import { getSellableMenu } from '../db/menu'
import { discardHeld, holdCart, listHeld, resumeHeld } from '../db/carts'
import { DEVICE_KEY, resolveTerminal } from '../db/device'
import { payOrder } from '../db/orders'
import { getSetting } from '../db/settings'
import { checkCode } from '../db/promos'
import { listActiveUsers } from '../db/users'
import { waitEstimate } from '../lib/queue'
import { priceCart, validateStatutory, type StatutoryInput } from '../lib/discount'
import { PAY_METHODS, TENDER_METHODS, applyLines, type PayLine, type PayMethod } from '../lib/payments'
import { parsePesos, pesos } from '../lib/money'
import {
  ORDER_TYPES, addLine, buildLine, cartCount, cartTotal, compTotal, compValue, rewardUnits, changeQty, duplicateLine, emptyCart, lineTotal, removeLine, replaceLine,
  type Cart, type CartLine, type OrderType,
} from '../lib/cart'
import { quote } from '../lib/modifierPricing'
import { formatPeso } from '../lib/money'
import { newId } from '../lib/id'
import { variantLabel } from '../db/menu'
import { Err, useAction } from '../ui'
import ItemPicker from './ItemPicker'
import Receipt from './Receipt'
import ApprovalPrompt from './ApprovalPrompt'
import { addRound } from '../db/tabs'
import { overLimitBy } from '../db/accounts'
import CustomerPicker from './CustomerPicker'
import { customerBalance } from '../db/loyalty'
import { createPreOrder } from '../db/preorders'
import { channelPriceMap } from '../db/channels'
import type { PayMethod as DepositMethod } from '../lib/payments'
import { getLimits } from '../db/approvals'
import { needsApproval } from '../lib/approval'
import { audit } from '../db/audit'
import ReasonFields, { NO_REASON, type Reason } from './ReasonFields'
import { checkReason } from '../lib/reasons'

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

/** Takes one or more payment lines (split tender). The key is made once per open panel, so a double tap can't save two orders. */
export function PayPanel({ total: base, onPay, onCancel, initialLines, practice }: { total: number; initialLines?: PayLine[]; practice?: boolean; onPay: (lines: PayLine[], key: string, buyer: { name: string; tin: string }, tip: number) => Promise<unknown>; onCancel: () => void }) {
  const [tip, setTip] = useState('')
  const [fx, setFx] = useState(false)
  const accounts = useLiveQuery(() => db.accounts.filter((a) => a.active).toArray(), [])
  const tipCents = practice || !tip.trim() ? 0 : parsePesos(tip) ?? 0 // a tip is paid on top, for staff
  const total = base + tipCents
  const [lines, setLines] = useState<PayLine[]>(initialLines ?? [])
  const [method, setMethod] = useState<PayMethod>('cash')
  const [f, setF] = useState({ amount: '', ref: '', code: '', last4: '' })
  const [key] = useState(newId)
  const [buyer, setBuyer] = useState({ name: '', tin: '' })
  const [busy, setBusy] = useState(false)
  const { error, run } = useAction()
  const balance = applyLines(total, lines).remaining
  const cents = parsePesos(f.amount)
  const touched = method === 'cash' ? f.amount !== '' : Object.values(f).some(Boolean)
  // An empty amount on an e-wallet or card means "the whole balance".
  const current: PayLine | null = !touched
    ? null
    : method === 'cash'
      ? { method, tendered: cents ?? 0 }
      : { method, amount: f.amount ? (cents ?? 0) : balance, reference: f.ref, approvalCode: f.code, last4: f.last4 }
  const all = current ? [...lines, current] : lines
  let result: ReturnType<typeof applyLines> | undefined
  let problem = ''
  try { result = applyLines(total, all) } catch (e) { problem = (e as Error).message }
  const set = (c: number) => setF({ ...f, amount: String(c / 100) })
  const field = (label: string, k: keyof typeof f, extra = {}) => (
    <input aria-label={label} placeholder={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} />
  )
  return (
    <div className="card">
      <div className="row between"><span>Total</span><strong>{formatPeso(total)}</strong></div>
      {lines.map((l, i) => (
        <div key={i} className="row between">
          <small>{PAY_METHODS.find((m) => m.id === l.method)?.label} {l.reference || l.approvalCode || ''}</small>
          <span>{formatPeso(applyLines(total, lines.slice(0, i + 1)).applied[i].amount)} <button onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button></span>
        </div>
      ))}
      <div className="seg">
        {TENDER_METHODS.filter((m) => !practice || (m.id !== 'giftcard' && m.id !== 'charge')).map((m) => (
          <button key={m.id} aria-pressed={method === m.id} onClick={() => { setMethod(m.id); setFx(false); setF({ amount: '', ref: '', code: '', last4: '' }) }}>{m.label}</button>
        ))}
        <button onClick={() => setFx(true)}>Foreign currency</button>
      </div>
      {method === 'cash' && (
        <div className="row">
          <button onClick={() => set(balance)}>Exact</button>
          {[100, 500, 1000].map((p) => <button key={p} onClick={() => set(pesos(p))}>{formatPeso(pesos(p)).replace('.00', '')}</button>)}
        </div>
      )}
      {field(method === 'cash' ? 'Cash tendered' : `Amount (blank = ${formatPeso(balance)})`, 'amount', { inputMode: 'decimal', autoFocus: true })}
      {(method === 'gcash' || method === 'maya' || method === 'transfer') && field('Reference number', 'ref')}
      {method === 'giftcard' && field('Gift card number (GC-1234-5678)', 'ref')}
      {method === 'charge' && (
        <select aria-label="Charge account" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })}>
          <option value="">Pick the account</option>
          {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}
        </select>
      )}
      {fx && <small role="status">Foreign currency is not accepted in the demo. Ask for pesos, GCash, Maya or a card.</small>}
      {method === 'card' && <>{field('Approval code', 'code')}{field('Last 4 digits', 'last4', { inputMode: 'numeric', maxLength: 4 })}</>}
      <p className="change" style={{ fontSize: '2rem' }}>
        {!result ? '' : result.remaining > 0 ? `Still to pay ${formatPeso(result.remaining)}` : `Change ${formatPeso(result.change)}`}
      </p>
      {problem && <small>{problem}</small>}
      {!practice && <input aria-label="Tip" size={12} inputMode="decimal" placeholder="Tip ₱ (optional)" value={tip} onChange={(e) => setTip(e.target.value)} />}
      {tipCents > 0 && <small>Includes a tip of {formatPeso(tipCents)} for staff. It is not a sale.</small>}
      {!practice && <details>
        <summary>Buyer name / TIN (business invoice)</summary>
        <input aria-label="Buyer name" placeholder="Buyer name" value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} />
        <input aria-label="Buyer TIN" placeholder="Buyer TIN" value={buyer.tin} onChange={(e) => setBuyer({ ...buyer, tin: e.target.value })} />
      </details>}
      <Err msg={error} />
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button
          disabled={!current || !result || result.remaining === 0}
          onClick={() => { setLines(all); setF({ amount: '', ref: '', code: '', last4: '' }) }}
        >
          Add another payment
        </button>
        <button
          className="primary"
          disabled={busy || !result || result.remaining > 0}
          onClick={async () => { setBusy(true); await run(() => onPay(all, key, buyer, tipCents)); setBusy(false) }}
        >
          Confirm payment
        </button>
      </div>
    </div>
  )
}

/** Senior/PWD: pick the ID holder's own items. The formula comes from the store's VAT setting, never from the cashier. */
function DiscountPanel({ cart, vat, onApply, onCancel }: { cart: Cart; vat: boolean; onApply: (d: StatutoryInput) => void; onCancel: () => void }) {
  const [d, setD] = useState<StatutoryInput>(cart.discount ?? { kind: 'senior', name: '', idNumber: '', signed: false, picks: {} })
  const { error, run } = useAction()
  const preview = priceCart({ ...cart, discount: d }, vat)
  const pick = (l: CartLine, units: number) => {
    const picks = { ...d.picks }
    if (units > 0) picks[l.id] = Math.min(units, l.qty)
    else delete picks[l.id]
    setD({ ...d, picks })
  }
  return (
    <div className="card">
      <div className="seg">
        {(['senior', 'pwd'] as const).map((k) => (
          <button key={k} aria-pressed={d.kind === k} onClick={() => setD({ ...d, kind: k })}>{k === 'senior' ? 'Senior Citizen' : 'PWD'}</button>
        ))}
      </div>
      <input aria-label="ID holder name" placeholder="ID holder name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      <input aria-label="ID number" placeholder="ID number" value={d.idNumber} onChange={(e) => setD({ ...d, idNumber: e.target.value })} />
      <small>Tick only the items the ID holder will consume.</small>
      {cart.lines.filter((l) => !l.comp).map((l) => (
        <div key={l.id} className="row between">
          <label>
            <input type="checkbox" checked={!!d.picks[l.id]} onChange={(e) => pick(l, e.target.checked ? l.qty : 0)} /> {l.name} <small>{l.variantLabel}</small>
          </label>
          {l.qty > 1 && !!d.picks[l.id] && (
            <input aria-label={`Units of ${l.name} for the ID holder`} type="number" min={1} max={l.qty} value={d.picks[l.id]} onChange={(e) => pick(l, Number(e.target.value))} style={{ width: '4rem' }} />
          )}
        </div>
      ))}
      <label><input type="checkbox" checked={d.signed} onChange={(e) => setD({ ...d, signed: e.target.checked })} /> ID holder signed</label>
      {preview.discount && <p>Discount −{formatPeso(preview.discount.reduction)} → pay {formatPeso(preview.total)}</p>}
      <Err msg={error} />
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button className="primary" onClick={() => run(async () => {
          validateStatutory(d)
          if (!preview.discount) throw new Error('Tick the items that belong to the ID holder')
          onApply(d)
        })}>Apply discount</button>
      </div>
    </div>
  )
}

export const billKey = (terminalId: string) => `pos-bill-${terminalId}` // set by the Tabs screen when a bill part is opened for payment
export type BillContext = { tabId: string; billId: string; partId: string; label: string }
function loadBill(terminalId: string): BillContext | null {
  try {
    const raw = localStorage.getItem(billKey(terminalId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Send what is in the cart to a table's tab as a round: the bar starts, the stock is taken, and it is paid at the end. */
function SendPanel({ terminalId, userId, cart, onSent, onCancel }: { terminalId: string; userId: string; cart: Cart; onSent: () => void; onCancel: () => void }) {
  const data = useLiveQuery(async () => {
    const terminal = await db.terminals.get(terminalId)
    const tables = terminal ? (await db.cafeTables.where('branchId').equals(terminal.branchId).toArray()).filter((t) => t.active) : []
    const tabs = (await db.tabs.where('status').equals('open').toArray()).filter((t) => t.branchId === terminal?.branchId)
    return { tables: tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), tabs }
  }, [terminalId])
  const [tableId, setTableId] = useState('')
  const [seat, setSeat] = useState('')
  const [key] = useState(newId)
  const [busy, setBusy] = useState(false)
  const { error, run } = useAction()
  if (!data) return null
  const busyTables = new Map(data.tabs.map((t) => [t.tableId, t]))
  return (
    <div className="card">
      <h4>Send to a table</h4>
      {data.tables.length === 0 && <p>No tables yet. The owner adds them on the Tabs screen.</p>}
      <select aria-label="Table" value={tableId} onChange={(e) => setTableId(e.target.value)}>
        <option value="">Pick a table</option>
        {data.tables.map((t) => <option key={t.id} value={t.id}>{t.name}{busyTables.has(t.id) ? ' (open tab: add a round)' : ''}</option>)}
      </select>
      <input aria-label="Seat" inputMode="numeric" placeholder="Seat (optional)" size={10} value={seat} onChange={(e) => setSeat(e.target.value.replace(/\D/g, ''))} />
      <Err msg={error} />
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button className="primary" disabled={!tableId || busy} onClick={async () => { setBusy(true); if (await run(() => addRound({ terminalId, userId, tableId, cart, seat: seat ? Number(seat) : undefined, idempotencyKey: key }))) onSent(); setBusy(false) }}>Send round</button>
      </div>
    </div>
  )
}

export const fulfilKey = (terminalId: string) => `pos-fulfil-${terminalId}` // set by the Pre-orders screen when a pre-order is collected
export type FulfilContext = { preOrderId: string; label: string; depositId?: string; depositAmount?: number }
function loadFulfil(terminalId: string): FulfilContext | null {
  try {
    const raw = localStorage.getItem(fulfilKey(terminalId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Save the cart as a pre-order: who, when, an optional deposit, and what happens to the deposit if it is cancelled. */
function PreOrderPanel({ terminalId, userId, cart, onSaved, onCancel }: { terminalId: string; userId: string; cart: Cart; onSaved: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: cart.name, phone: '', kind: 'pickup' as 'pickup' | 'delivery', at: '', deposit: '', method: 'cash' as DepositMethod, ref: '', policy: 'refund' as 'refund' | 'keep', note: '' })
  const [key] = useState(newId)
  const { error, run } = useAction()
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch })
  return (
    <div className="card">
      <h4>Save as a pre-order</h4>
      <input aria-label="Customer name" placeholder="Customer or company" value={f.name} onChange={(e) => set({ name: e.target.value })} />
      <input aria-label="Phone" placeholder="Mobile (optional)" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
      <div className="row">
        <select aria-label="Pickup or delivery" value={f.kind} onChange={(e) => set({ kind: e.target.value as 'pickup' | 'delivery' })}><option value="pickup">Pickup</option><option value="delivery">Delivery</option></select>
        <label>When <input type="datetime-local" value={f.at} onChange={(e) => set({ at: e.target.value })} /></label>
      </div>
      <div className="row">
        <input aria-label="Deposit" size={9} inputMode="decimal" placeholder="Deposit ₱ (optional)" value={f.deposit} onChange={(e) => set({ deposit: e.target.value })} />
        <select aria-label="Deposit paid by" value={f.method} onChange={(e) => set({ method: e.target.value as DepositMethod })}>
          {TENDER_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {f.deposit && f.method !== 'cash' && <input aria-label="Deposit reference" placeholder="Reference no." value={f.ref} onChange={(e) => set({ ref: e.target.value })} />}
      </div>
      <label>If cancelled, the deposit is{' '}
        <select value={f.policy} onChange={(e) => set({ policy: e.target.value as 'refund' | 'keep' })}><option value="refund">refunded</option><option value="keep">kept</option></select>
      </label>
      <input aria-label="Note" placeholder="Note (optional)" value={f.note} onChange={(e) => set({ note: e.target.value })} />
      <Err msg={error} />
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <button
          className="primary"
          onClick={async () => {
            const dep = f.deposit.trim() ? parsePesos(f.deposit) : undefined
            if (dep === null) return void run(() => Promise.reject(new Error('Enter the deposit in pesos, like 1500')))
            if (await run(() => createPreOrder({
              terminalId, userId, customerName: f.name, phone: f.phone, kind: f.kind, pickupAt: f.at ? new Date(f.at).toISOString() : '', lines: cart.lines, deliveryFee: cart.deliveryFee, note: f.note,
              depositPolicy: f.policy, ...(dep ? { deposit: { amount: dep, method: f.method, reference: f.ref } } : {}), idempotencyKey: key,
            }))) onSaved()
          }}
        >
          Save pre-order
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
  const [sending, setSending] = useState(false)
  const [bill, setBill] = useState<BillContext | null>(() => loadBill(terminalId))
  const [fulfil, setFulfil] = useState<FulfilContext | null>(() => loadFulfil(terminalId))
  const [preSaving, setPreSaving] = useState(false)
  const [pickingCustomer, setPickingCustomer] = useState(false)
  const svcPct = useLiveQuery(() => getSetting('serviceChargePct'), [])
  const [chargeAsk, setChargeAsk] = useState<{ over: number } | null>(null)
  const [chargeAppr, setChargeAppr] = useState<string | null>(null)
  const cust = useLiveQuery(async () => {
    const c = cart.customerId ? await db.customers.get(cart.customerId) : undefined
    return c ? { c, ...(await customerBalance(c.id)) } : null
  }, [cart.customerId, cart.lines.length])
  const prog = useLiveQuery(() => import('../db/loyalty').then((m) => m.getProgramme()), [])
  const channels = useLiveQuery(() => db.channels.filter((c) => c.active).toArray(), [])
  const channelPrices = useLiveQuery(() => (cart.channelId ? channelPriceMap(cart.channelId) : Promise.resolve(new Map<string, number>())), [cart.channelId])
  const locked = !!bill || !!fulfil
  const [asking, setAsking] = useState<'discount' | 'comp' | null>(null)
  const [approval, setApproval] = useState<{ id: string; amount: number } | null>(null) // supervisor approval for a big discount
  const [compApproval, setCompApproval] = useState<{ id: string; amount: number } | null>(null) // ... and for a big comp
  const [comping, setComping] = useState('') // line id being comped
  const [reason, setReason] = useState<Reason>(NO_REASON)
  const limits = useLiveQuery(getLimits, [])
  const drawer = useLiveQuery(async () => ({ cash: await expectedCash(shiftId), limit: await getSetting('cashDropLimitCentavos') }), [shiftId, cart.lines.length])
  const [showInvoice, setShowInvoice] = useState(false)
  const [discounting, setDiscounting] = useState(false)
  const vat = useLiveQuery(() => getSetting('vatRegistered'), [])
  const promos = useLiveQuery(() => db.promos.filter((p) => p.active).toArray(), [])
  const empPct = useLiveQuery(() => getSetting('employeeDiscountPct'), [])
  const staff = useLiveQuery(listActiveUsers, [])
  const [code, setCode] = useState('')
  const [pickingStaff, setPickingStaff] = useState(false)
  const open = useLiveQuery(() => db.queueItems.where('status').anyOf('queued', 'making').toArray(), [])
  const perItem = useLiveQuery(() => getSetting('queueMinutesPerItem'), [])
  const [done, setDone] = useState<{ orderId: string; number: number; change: number; pending: boolean; earned: number } | null>(null)
  const rawMenu = useLiveQuery(getSellableMenu, [])
  const held = useLiveQuery(() => listHeld(terminalId), [terminalId])
  const { error, run } = useAction()

  useEffect(() => {
    localStorage.setItem(cartKey(terminalId), JSON.stringify(cart))
  }, [cart, terminalId])

  if (svcPct === undefined || !rawMenu || !channels || !channelPrices || !held || vat === undefined || !open || perItem === undefined || !limits || !promos || empPct === undefined || !staff) return null
  const bar = waitEstimate(open, 'bar', perItem)
  const kitchen = waitEstimate(open, 'kitchen', perItem)
  // One reduction only: Senior/PWD, staff or the best promo, whichever gives the lowest price. Re-worked on every cart change.
  const priced = priceCart(cart, vat, { promos, employeePct: empPct })
  const reduction = priced.discount?.reduction ?? priced.employee?.reduction ?? 0
  const comped = compTotal(cart)
  const askDiscount = needsApproval(user.role, 'discount', reduction, limits) && !(approval && approval.amount >= reduction)
  const askComp = needsApproval(user.role, 'comp', comped, limits) && !(compApproval && compApproval.amount >= comped)
  // Ask for whichever approval is missing, then open payment.
  const proceed = (d = askDiscount, c = askComp) => { setDiscounting(false); if (d) setAsking('discount'); else if (c) setAsking('comp'); else { setAsking(null); setPaying(true) } }
  // At a delivery app's prices, the same menu shows the app's price for each size (add-on prices stay as they are).
  const menu = channelPrices.size === 0 ? rawMenu : rawMenu.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, variants: i.variants.map((v) => ({ ...v, price: channelPrices.get(v.id) ?? v.price })) })) }))
  const fee = cart.deliveryFee ?? 0
  const service = cart.serviceCharge ? Math.round((priced.total * svcPct) / 100) : 0
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
        {locked ? (
          <p>{bill ? <>Paying <strong>{bill.label}</strong> from a tab. Its drinks are already made; add more on the tab.</> : <>Collecting pre-order <strong>{fulfil!.label}</strong>. The deposit is applied below; the rest is paid now.</>}</p>
        ) : (
          <>
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
          </>
        )}
        {picking && (
          <ItemPicker key={picking.initial?.id ?? picking.item.id} item={picking.item} initial={picking.initial} onConfirm={confirmPick} onCancel={() => setPicking(null)} />
        )}
      </section>

      <aside className="cart card">
        {drawer && drawer.cash > drawer.limit && (
          <p role="status"><strong>The drawer is over {formatPeso(drawer.limit)}.</strong> Ask a supervisor for a cash drop (Shift tab).</p>
        )}
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
        {!locked && (
          <div className="row">
            <select
              aria-label="Sold through"
              value={cart.channelId ?? ''}
              onChange={(e) => {
                const id = e.target.value || undefined
                const price = new Map<string, number>()
                for (const c of rawMenu) for (const i of c.items) for (const v of i.variants) price.set(v.id, v.price)
                // keep the lines, at the new channel's prices (counter prices when it is cleared)
                run(async () => {
                  const over = id ? await channelPriceMap(id) : new Map<string, number>()
                  commit({ ...cart, channelId: id, lines: cart.lines.map((l) => ({ ...l, basePrice: over.get(l.variantId) ?? price.get(l.variantId) ?? l.basePrice })) })
                })
              }}
            >
              <option value="">Counter</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input aria-label="Delivery fee" size={9} inputMode="decimal" placeholder="Delivery fee ₱" value={fee ? String(fee / 100) : ''} onChange={(e) => { const v = e.target.value.trim() === '' ? 0 : parsePesos(e.target.value); if (v !== null) setCart({ ...cart, deliveryFee: v || undefined }) }} />
          </div>
        )}
        {!locked && (
          pickingCustomer ? (
            <CustomerPicker onCancel={() => setPickingCustomer(false)} onPick={(c) => { setCart({ ...cart, customerId: c.id, name: cart.name || c.name }); setPickingCustomer(false) }} />
          ) : cust ? (
            <div className="row between">
              <small>
                {cust.c.name}{cust.programme.mode !== 'off' && ` · ${cust.balance} ${cust.programme.mode === 'points' ? 'points' : 'stamps'}${cust.balance >= cust.programme.rewardAt ? ' · FREE DRINK AVAILABLE' : ''}`}
                {cust.expiringSoon.length > 0 && ` · ${cust.expiringSoon.reduce((s, x) => s + x.amount, 0)} expire by ${new Date(cust.expiringSoon[0].expiresAt).toLocaleDateString('en-PH')}`}
              </small>
              <button onClick={() => setCart({ ...cart, customerId: undefined, lines: cart.lines.map((l) => (l.comp?.code === 'loyalty-reward' ? { ...l, comp: undefined } : l)) })}>Remove</button>
            </div>
          ) : (
            <button onClick={() => setPickingCustomer(true)}>Customer / loyalty</button>
          )
        )}
        <small>The order number is given when the order is paid.</small>
        <small>
          Bar: {bar.waiting === 0 ? 'no wait' : `about ${bar.minutes} min`}
          {kitchen.waiting > 0 && ` · Kitchen: about ${kitchen.minutes} min`}. Tell the customer before they pay.
        </small>

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
                <strong>{l.comp ? `COMP (${formatPeso(compValue(l))})` : formatPeso(lineTotal(l))}</strong>
              </div>
              {comping === l.id && (
                <div className="row">
                  <ReasonFields value={reason} onChange={setReason} />
                  <button onClick={() => run(async () => { checkReason(reason.code, reason.note); commit({ ...cart, lines: cart.lines.map((x) => (x.id === l.id ? { ...x, comp: { code: reason.code, note: reason.note } } : x)) }); setComping('') })}>Give free</button>
                  <button onClick={() => setComping('')}>Cancel</button>
                </div>
              )}
              {!locked && (
              <div className="row">
                <button aria-label={`Less ${l.name}`} onClick={() => commit(changeQty(cart, l.id, -1))}>−</button>
                <span className="qty">{l.qty}</span>
                <button aria-label={`More ${l.name}`} onClick={() => commit(changeQty(cart, l.id, 1))}>+</button>
                <button onClick={() => editLine(l)}>Edit</button>
                <button onClick={() => commit(duplicateLine(cart, l.id, newId()))}>Duplicate</button>
                <button onClick={() => { run(() => audit({ userId: user.id, action: 'line.void', detail: { name: l.name, qty: l.qty, amount: lineTotal(l) } })); commit(removeLine(cart, l.id)) }}>Remove</button>
                <button onClick={() => { if (l.comp) commit({ ...cart, lines: cart.lines.map((x) => (x.id === l.id ? { ...x, comp: undefined } : x)) }); else { setReason(NO_REASON); setComping(l.id) } }}>{l.comp ? (l.comp.code === 'loyalty-reward' ? 'Undo reward' : 'Undo comp') : 'Comp'}</button>
                {!l.comp && cust && cust.programme.mode !== 'off' && Math.floor(cust.balance / cust.programme.rewardAt) > rewardUnits(cart) && l.qty === 1 && (
                  <button onClick={() => commit({ ...cart, lines: cart.lines.map((x) => (x.id === l.id ? { ...x, comp: { code: 'loyalty-reward', note: '' } } : x)) })}>Free drink (reward)</button>
                )}
              </div>
              )}
            </li>
          ))}
        </ul>

        <div className="row between total">
          <span>{cartCount(cart)} item{cartCount(cart) === 1 ? '' : 's'}</span>
          <strong>{formatPeso(priced.total)}</strong>
        </div>
        {fee > 0 && <div className="row between"><small>Delivery fee (not a sale)</small><strong>{formatPeso(fee)}</strong></div>}
        <label><input type="checkbox" checked={!!cart.serviceCharge} onChange={(e) => setCart({ ...cart, serviceCharge: e.target.checked || undefined })} /> Service charge {svcPct}% <small>(for staff, not a sale)</small></label>
        {service > 0 && <div className="row between"><small>Service charge</small><strong>{formatPeso(service)}</strong></div>}
        {priced.discount && (
          <div className="row between">
            <small>{priced.discount.kind === 'senior' ? 'Senior' : 'PWD'} discount ({priced.discount.name}) −{formatPeso(priced.discount.reduction)}</small>
            <button onClick={() => setCart({ ...cart, discount: undefined })}>Remove</button>
          </div>
        )}
        {priced.employee && (
          <div className="row between">
            <small>Staff discount {priced.employee.pct}% ({priced.employee.name}) −{formatPeso(priced.employee.reduction)}</small>
            <button onClick={() => setCart({ ...cart, employee: undefined })}>Remove</button>
          </div>
        )}
        {priced.promo && (
          <div className="row between">
            <small>Promo: {priced.promo.name}{priced.promo.code && ` (${priced.promo.code})`} −{formatPeso(priced.promo.reduction)}</small>
          </div>
        )}
        {priced.considered.length > 1 && (
          <small role="status">{priced.considered.map((c) => `${c.label} ${formatPeso(c.total)}`).join(' vs ')}: the lower price applies, never both.</small>
        )}
        {cart.discount && priced.statutoryLost && <small role="status">The Senior/PWD discount is not used because a lower price applies.</small>}
        <div className="row">
          <input aria-label="Promo code" placeholder="Promo code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button disabled={!code.trim()} onClick={() => run(async () => { const p = await checkCode(code); setCart({ ...cart, promoCode: p.code }); setCode('') })}>Apply code</button>
          {cart.promoCode && <button onClick={() => setCart({ ...cart, promoCode: undefined })}>Remove code {cart.promoCode}</button>}
        </div>
        {empPct > 0 && !cart.employee && !cart.discount && (
          pickingStaff ? (
            <select aria-label="Staff member" defaultValue="" onChange={(e) => { const u = staff.find((x) => x.id === e.target.value); if (u) setCart({ ...cart, employee: { id: u.id, name: u.name } }); setPickingStaff(false) }}>
              <option value="">Who is it for?</option>
              {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          ) : (
            <button onClick={() => setPickingStaff(true)} disabled={cart.lines.length === 0}>Staff discount</button>
          )
        )}
        <div className="row">
          {!locked && <button onClick={undo} disabled={history.length === 0}>Undo</button>}
          {!locked && <button onClick={() => commit({ ...cart, lines: [] })} disabled={cart.lines.length === 0}>Clear</button>}
          {!locked && <button onClick={hold} disabled={cart.lines.length === 0}>Hold</button>}
          {!locked && <button onClick={() => { setPaying(false); setSending(true) }} disabled={cart.lines.length === 0}>Send to table</button>}
          {!locked && <button onClick={() => { setPaying(false); setPreSaving(true) }} disabled={cart.lines.length === 0}>Pre-order</button>}
          {fulfil && <button onClick={() => { localStorage.removeItem(fulfilKey(terminalId)); setFulfil(null); setCart(emptyCart()); setPaying(false) }}>Back to pre-orders</button>}
          {bill && <button onClick={() => { localStorage.removeItem(billKey(terminalId)); setBill(null); setCart(emptyCart()); setPaying(false) }}>Back to tab</button>}
          <button onClick={() => { setPaying(false); setDiscounting(true) }} disabled={cart.lines.length === 0}>Senior/PWD</button>
          <button className="primary" onClick={() => proceed()} disabled={cart.lines.length === 0}>Take payment</button>
        </div>
        <Err msg={error} />
        {preSaving && <PreOrderPanel terminalId={terminalId} userId={user.id} cart={cart} onCancel={() => setPreSaving(false)} onSaved={() => { setCart(emptyCart()); setHistory([]); setPreSaving(false) }} />}
        {sending && <SendPanel terminalId={terminalId} userId={user.id} cart={cart} onCancel={() => setSending(false)} onSent={() => { setCart(emptyCart()); setHistory([]); setSending(false) }} />}
        {discounting && (
          <DiscountPanel cart={cart} vat={vat} onCancel={() => setDiscounting(false)} onApply={(discount) => { setCart({ ...cart, discount }); setDiscounting(false) }} />
        )}
        {chargeAsk && (
          <ApprovalPrompt action="charge" amount={chargeAsk.over} requesterId={user.id} title={`The account is ${formatPeso(chargeAsk.over)} over its limit: supervisor PIN needed.`}
            onCancel={() => setChargeAsk(null)} onApproved={(a) => { setChargeAppr(a.id); setChargeAsk(null) }} />
        )}
        {asking && (
          <ApprovalPrompt
            action={asking}
            amount={asking === 'discount' ? reduction : comped}
            requesterId={user.id}
            title={`${asking === 'discount' ? 'Discount' : 'Comp'} of ${formatPeso(asking === 'discount' ? reduction : comped)} is above your limit. Supervisor PIN needed.`}
            onCancel={() => setAsking(null)}
            onApproved={(a) => {
              const got = { id: a.id, amount: a.amount }
              if (asking === 'discount') { setApproval(got); proceed(false, askComp) } else { setCompApproval(got); proceed(askDiscount, false) }
            }}
          />
        )}
        {paying && cart.channelId && (
          <div className="card">
            <p>Paid by <strong>{channels.find((c) => c.id === cart.channelId)?.name}</strong> later. It is a sale now and a receivable until the app pays out, less its commission.</p>
            <div className="row">
              <button onClick={() => setPaying(false)}>Back</button>
              <button className="primary" onClick={() => run(async () => {
                const { order } = await payOrder(terminalId, user.id, cart, [{ method: 'platform', amount: priced.total + fee }], newId())
                setCart(emptyCart()); setHistory([]); setPaying(false)
                setDone({ orderId: order.id, number: order.number, change: 0, pending: false, earned: 0 })
              })}>Confirm delivery app order</button>
            </div>
          </div>
        )}
        {paying && !cart.channelId && (
          <PayPanel
            total={priced.total + fee + service}
            initialLines={fulfil?.depositId ? [{ method: 'deposit', amount: fulfil.depositAmount, reference: fulfil.depositId }] : undefined}
            onCancel={() => setPaying(false)}
            onPay={async (lines, key, buyer, tip) => {
              const chg = lines.find((l) => l.method === 'charge')
              if (chg && !chargeAppr) {
                const over = await overLimitBy(chg.reference!, chg.amount ?? 0)
                if (over > 0) { setChargeAsk({ over }); throw new Error('That is over the account limit. Get a supervisor PIN, then confirm again.') }
              }
              const { order, payments, change, earned } = await payOrder(terminalId, user.id, { ...cart, tip: tip || undefined }, lines, key, buyer, { discount: askDiscount ? undefined : approval?.id, comp: askComp ? undefined : compApproval?.id, charge: chargeAppr ?? undefined }, bill ? { tabId: bill.tabId, billId: bill.billId, partId: bill.partId } : undefined, fulfil ? { preOrderId: fulfil.preOrderId } : undefined)
              if (bill) { localStorage.removeItem(billKey(terminalId)); setBill(null) }
              if (fulfil) { localStorage.removeItem(fulfilKey(terminalId)); setFulfil(null) }
              setCart(emptyCart())
              setHistory([])
              setApproval(null)
              setCompApproval(null)
              setChargeAppr(null)
              setPaying(false)
              setDone({ orderId: order.id, number: order.number, change: change ?? 0, pending: payments.some((p) => p.status === 'pending'), earned: earned ?? 0 })
            }}
          />
        )}
        {done && (
          <div className="card" role="status">
            <p>Order #{done.number} paid</p>
            <p className="change">Change {formatPeso(done.change)}</p>
            {done.earned > 0 && <p>Earned {done.earned} {prog?.mode === 'points' ? 'point(s)' : 'stamp(s)'}.</p>}
            {done.pending && <p>E-wallet payment is pending. A supervisor verifies it in the Orders tab once it shows in the merchant app.</p>}
            <button onClick={() => setShowInvoice(true)}>Invoice</button>
            <button onClick={() => { setDone(null); setShowInvoice(false) }}>Next order</button>
            {showInvoice && <Receipt orderId={done.orderId} onClose={() => setShowInvoice(false)} />}
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
