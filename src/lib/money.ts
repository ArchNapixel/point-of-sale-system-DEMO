// Money is always integer centavos (design rule 1). Never use floats for amounts.
export type Centavos = number

export const pesos = (p: number): Centavos => Math.round(p * 100)

export const formatPeso = (c: Centavos): string =>
  `₱${(c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Parses a typed peso amount ("168", "33.60") to centavos. Returns null if it isn't a valid amount >= 0. */
export function parsePesos(text: string): Centavos | null {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) return null
  return Math.round(Number(text) * 100)
}

/** Percentage of an amount, rounded half-up to a whole centavo (same rule everywhere). */
export const pct = (c: Centavos, percent: number): Centavos => Math.round((c * percent) / 100)
