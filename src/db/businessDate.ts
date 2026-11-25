/** Business date (YYYY-MM-DD, local time): times before the cutoff hour belong to the previous day. */
export function businessDate(at: Date, cutoffHour: number): string {
  const d = new Date(at.getTime() - cutoffHour * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
