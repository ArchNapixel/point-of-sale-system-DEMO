import { cartTotal, lineUnit, type Cart } from './cart'

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

/** What the customer pays for this cart. A discount with no ticked items on the cart is ignored (items may have been removed). */
export function priceCart(cart: Cart, vatRegistered: boolean) {
  const gross = cartTotal(cart)
  const d = cart.discount
  const lines: DiscountLine[] = d
    ? cart.lines.flatMap((l) => {
        const units = Math.min(Math.floor(d.picks[l.id] ?? 0), l.qty)
        return units > 0 ? [{ lineId: l.id, name: l.name, units, ...statutoryLine(lineUnit(l) * units, vatRegistered) }] : []
      })
    : []
  if (!d || lines.length === 0) return { gross, total: gross, discount: undefined }
  const reduction = lines.reduce((s, l) => s + l.base - l.pay, 0)
  const discount: OrderDiscount = {
    kind: d.kind,
    name: d.name.trim(),
    idNumber: normId(d.idNumber),
    vatRegistered,
    lines,
    vatExempt: lines.reduce((s, l) => s + l.vatExempt, 0),
    discountAmount: lines.reduce((s, l) => s + l.discount, 0),
    reduction,
  }
  return { gross, total: gross - reduction, discount }
}
