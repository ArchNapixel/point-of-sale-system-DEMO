/**
 * Shares a pool of centavos between people in proportion to the hours they worked. Every centavo is handed out: each person gets the
 * whole centavos they earned, then the leftover centavos go to those with the largest fractions (ties to the longer shift).
 */
export function shareByHours(pool: number, hours: Map<string, number>): Map<string, number> {
  const total = [...hours.values()].reduce((s, h) => s + h, 0)
  const out = new Map<string, number>()
  if (total <= 0 || pool <= 0) return out
  const parts = [...hours].filter(([, h]) => h > 0).map(([id, h]) => ({ id, h, exact: (pool * h) / total }))
  for (const p of parts) out.set(p.id, Math.floor(p.exact))
  let left = pool - [...out.values()].reduce((s, v) => s + v, 0)
  for (const p of [...parts].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || b.h - a.h || a.id.localeCompare(b.id))) {
    if (left <= 0) break
    out.set(p.id, out.get(p.id)! + 1)
    left--
  }
  return out
}
