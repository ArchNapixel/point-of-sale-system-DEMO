import { cartTotal, lineUnit, type Cart } from './cart'
import { bestPromo, employeeReduction, type Promo, type Reduction } from './promos'

// Senior Citizen / PWD discount. Demo behaviour only: check with an accountant/BIR before real use.
export type StatutoryInput = {
  kind: 'senior' | 'pwd' // one statutory discount per purchase: a cart holds one of these, never two
  name: string
  idNumber: string
  signed: boolean // ID holder signed on the paper line
  picks: Record<string, number> // cart line id -> units that belong to the ID holder
}
export type DiscountLine = { lineId: string; name: string; units: number; base: number; vatExempt: number; discount: number; pay: number }
export type OrderDiscount = {
  kind: StatutoryInput['kind']
  name: string
  idNumber: string
  vatRegistered: boolean
  lines: DiscountLine[]
  vatExempt: number // total VAT-exempt amount of the ID holder's items
  discountAmount: number // the 20% part, as printed on the invoice
  reduction: number // what the customer saves in total (VAT removed + 20%)
}

export const normId = (s: string) => s.trim().toUpperCase()

/** One line's discount. VAT-registered: price ÷ 1.12, then 20% off that. Non-VAT: 20% off the price. Rounded per line, half-up. */
export function statutoryLine(base: number, vatRegistered: boolean) {
  const vatExempt = vatRegistered ? Math.round(base / 1.12) : base
  const discount = Math.round(vatExempt * 0.2)
  return { base, vatExempt, discount, pay: vatExempt - discount }
}

export function validateStatutory(d: StatutoryInput) {
  if (!d.name.trim()) throw new Error("Enter the ID holder's name")
  if (!normId(d.idNumber)) throw new Error('Enter the ID number. Only IDs actually shown get the discount.')
  if (!d.signed) throw new Error('The ID holder must sign before the discount applies')
}

export type AppliedPromo = { promoId: string; name: string; code?: string; kind: string; reduction: number; lines: Reduction['lines'] }
export type AppliedEmployee = { employeeId: string; name: string; pct: number; reduction: number; lines: Reduction['lines'] }

function statutoryFor(cart: Cart, vatRegistered: boolean): OrderDiscount | undefined {
  const d = cart.discount
  const lines: DiscountLine[] = d
    ? cart.lines.flatMap((l) => {
        if (l.comp) return [] // a comped line is already free
        const units = Math.min(Math.floor(d.picks[l.id] ?? 0), l.qty)
        return units > 0 ? [{ lineId: l.id, name: l.name, units, ...statutoryLine(lineUnit(l) * units, vatRegistered) }] : []
      })
    : []
  if (!d || lines.length === 0) return undefined
  return {
    kind: d.kind,
    name: d.name.trim(),
    idNumber: normId(d.idNumber),
    vatRegistered,
    lines,
    vatExempt: lines.reduce((s, l) => s + l.vatExempt, 0),
    discountAmount: lines.reduce((s, l) => s + l.discount, 0),
    reduction: lines.reduce((s, l) => s + l.base - l.pay, 0),
  }
}

/**
 * What the customer pays for this cart. Only ONE reduction applies, never two stacked: Senior/PWD, a staff discount, or the best promo,
 * whichever gives the lowest price (a tie goes to Senior/PWD, then staff, then promo). Staff discount is ignored when Senior/PWD is on the cart.
 * `considered` lists every option so the cashier sees both prices. A Senior/PWD discount with no ticked items is ignored (items may have been removed).
 */
export function priceCart(cart: Cart, vatRegistered: boolean, opts: { promos?: Promo[]; employeePct?: number; now?: Date } = {}) {
  const gross = cartTotal(cart)
  const stat = statutoryFor(cart, vatRegistered)
  const emp = !stat && cart.employee && opts.employeePct ? employeeReduction(opts.employeePct, cart) : null
  const promo = opts.promos ? bestPromo(opts.promos, cart, opts.now ?? new Date()) : null
  const options: { kind: 'statutory' | 'employee' | 'promo'; reduction: number; label: string }[] = []
  if (stat) options.push({ kind: 'statutory', reduction: stat.reduction, label: stat.kind === 'pwd' ? 'PWD' : 'Senior' })
  if (emp && cart.employee) options.push({ kind: 'employee', reduction: emp.total, label: `Staff (${cart.employee.name})` })
  if (promo) options.push({ kind: 'promo', reduction: promo.r.total, label: promo.promo.name })
  const win = options.reduce<(typeof options)[number] | undefined>((a, b) => (!a || b.reduction > a.reduction ? b : a), undefined)
  const reduction = win?.reduction ?? 0
  return {
    gross,
    total: gross - reduction,
    discount: win?.kind === 'statutory' ? stat : undefined,
    employee: win?.kind === 'employee' && emp && cart.employee
      ? ({ employeeId: cart.employee.id, name: cart.employee.name, pct: opts.employeePct!, reduction: emp.total, lines: emp.lines } satisfies AppliedEmployee)
      : undefined,
    promo: win?.kind === 'promo' && promo
      ? ({ promoId: promo.promo.id, name: promo.promo.name, ...(promo.promo.code && { code: promo.promo.code }), kind: promo.promo.kind, reduction: promo.r.total, lines: promo.r.lines } satisfies AppliedPromo)
      : undefined,
    statutoryLost: !!stat && win?.kind !== 'statutory',
    considered: options.map((o) => ({ kind: o.kind, label: o.label, total: gross - o.reduction })),
  }
}
