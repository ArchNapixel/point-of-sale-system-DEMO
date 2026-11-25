import type { TimeEntry } from '../db/db'

const HOUR = 3_600_000

/** Hours worked, to 2 decimals. An entry still open has no hours yet. */
export const entryHours = (e: Pick<TimeEntry, 'inAt' | 'outAt'>) => (e.outAt ? Math.round(((Date.parse(e.outAt) - Date.parse(e.inAt)) / HOUR) * 100) / 100 : 0)

/** Forgot to clock out: an entry running (or closed) longer than the limit is flagged for a supervisor to fix. */
export const isLong = (e: Pick<TimeEntry, 'inAt' | 'outAt'>, now: Date, limitHours: number) =>
  ((e.outAt ? Date.parse(e.outAt) : now.getTime()) - Date.parse(e.inAt)) / HOUR > limitHours

const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))

/** Hours per person for payroll (done in a spreadsheet). One row per entry, then a total per person. */
export function hoursCsv(entries: TimeEntry[], names: Map<string, string>, now: Date, limitHours: number) {
  const rows = [['Name', 'Business date', 'Clock in', 'Clock out', 'Hours', 'Flag'].map(cell).join(',')]
  const byPerson = new Map<string, TimeEntry[]>()
  for (const e of [...entries].sort((a, b) => a.inAt.localeCompare(b.inAt))) byPerson.set(e.userId, [...(byPerson.get(e.userId) ?? []), e])
  for (const [id, list] of [...byPerson].sort((a, b) => (names.get(a[0]) ?? '').localeCompare(names.get(b[0]) ?? ''))) {
    const name = names.get(id) ?? id
    for (const e of list) {
      const flags = [!e.outAt ? 'still clocked in' : '', isLong(e, now, limitHours) ? 'long shift' : '', e.edits?.length ? 'time fixed' : ''].filter(Boolean).join('; ')
      rows.push([name, e.businessDate, e.inAt, e.outAt ?? '', entryHours(e), flags].map(cell).join(','))
    }
    rows.push([name, '', '', 'TOTAL', Math.round(list.reduce((s, e) => s + entryHours(e), 0) * 100) / 100, ''].map(cell).join(','))
  }
  return rows.join('\n')
}
