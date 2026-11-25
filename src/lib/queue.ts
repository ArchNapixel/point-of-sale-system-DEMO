export type Station = 'bar' | 'kitchen' | 'none' // none = needs no prep (bottled water): no ticket, completes on its own
export const STATIONS: { id: Station; label: string }[] = [
  { id: 'bar', label: 'Bar' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'none', label: 'No prep' },
]
export type QueueStatus = 'queued' | 'making' | 'ready' | 'served'
export const FLOW: QueueStatus[] = ['queued', 'making', 'ready', 'served']
export const STATUS_ACTION: Record<QueueStatus, string> = { queued: '', making: 'Start', ready: 'Ready', served: 'Picked up' }
export const UNDO_MS = 60_000 // a wrong tap can be undone for a minute
export const RUSH_REASONS = ['Rider waiting', 'Pre-order due', 'Remake', 'Other']

type Open = { station: Station; status: QueueStatus; qty: number }

/** "About N min": items still queued or being made × minutes per item (a setting). */
export function waitEstimate(items: Open[], station: Station, minutesPerItem: number) {
  const waiting = items.filter((i) => i.station === station && (i.status === 'queued' || i.status === 'making')).reduce((s, i) => s + i.qty, 0)
  return { waiting, minutes: waiting * minutesPerItem }
}

/** Rush orders first, then oldest first. */
export const byUrgency = <T extends { rush: boolean; createdAt: string }>(a: T, b: T) =>
  Number(b.rush) - Number(a.rush) || a.createdAt.localeCompare(b.createdAt)

/** An order is ready only when every one of its items is ready or already picked up. */
export const orderReady = (items: { status: QueueStatus }[]) => items.length > 0 && items.every((i) => i.status === 'ready' || i.status === 'served')
