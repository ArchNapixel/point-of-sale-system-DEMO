import type { Order } from '../db/db'

export const formatInvoiceNo = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`

/**
 * The money lines printed on an invoice. VAT-registered prices include VAT, so the VATable part is backed out (÷ 1.12).
 * ID-holder items are VAT-exempt and show the 20% as a discount. A non-VAT café drops the VAT lines.
 * Always: vatable + vat + vatExempt - discount = amount due (= order.total).
 */
export function invoiceFigures(o: Pick<Order, 'gross' | 'total' | 'vatRegistered' | 'discount'>) {
  const discount = o.discount?.discountAmount ?? 0
  if (!o.vatRegistered) return { vatRegistered: false as const, sales: o.gross, discount, due: o.total }
  const exemptBase = o.discount?.lines.reduce((s, l) => s + l.base, 0) ?? 0
  const rest = o.gross - exemptBase
  const vatable = Math.round(rest / 1.12)
  return { vatRegistered: true as const, vatable, vat: rest - vatable, vatExempt: o.discount?.vatExempt ?? 0, discount, due: o.total }
}

/** Search box for past sales: invoice number, order number, customer/table, business date or buyer. */
export function matchesOrder(o: Order, q: string) {
  const t = q.trim().toLowerCase()
  if (!t) return true
  return [o.invoiceNo, `#${o.number}`, String(o.number), o.name, o.table, o.businessDate, o.buyer?.name, o.discount?.idNumber]
    .some((f) => f?.toLowerCase().includes(t))
}
