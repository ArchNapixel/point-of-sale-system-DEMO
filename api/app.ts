import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { sql } from './db.ts'

export const app = new Hono()

const MAX_RECORDS = 500
const NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/ // a table name from the app, never run as SQL: it is only stored as text

function authorised(header: string | undefined) {
  const key = process.env.SYNC_API_KEY
  if (!key || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

app.get('/health', (c) => c.json({ ok: true }))

// Proves the API can reach Neon. Shows no secrets.
app.get('/health/db', async (c) => {
  const [row] = await sql().query('select now() as time, current_database() as database')
  return c.json({ ok: true, database: row.database, time: row.time })
})

type Rec = { table: string; id: string; at: string; payload: Record<string, unknown> }

/**
 * Devices push the records they made. Each record is stored once: the same (table, id) again is ignored, so a retry or a double
 * send never makes a duplicate. Returns how many were new and how many were already there.
 */
app.post('/sync', async (c) => {
  if (!authorised(c.req.header('authorization'))) return c.json({ error: 'unauthorised' }, 401)
  const body = (await c.req.json().catch(() => null)) as { device?: string; records?: Rec[] } | null
  if (!body || typeof body.device !== 'string' || !body.device.trim() || !Array.isArray(body.records)) return c.json({ error: 'expected { device, records[] }' }, 400)
  if (body.records.length > MAX_RECORDS) return c.json({ error: `at most ${MAX_RECORDS} records per request` }, 413)
  for (const r of body.records) {
    if (!r || !NAME.test(r.table) || typeof r.id !== 'string' || !r.id || r.id.length > 64 || Number.isNaN(Date.parse(r.at)) || typeof r.payload !== 'object' || r.payload === null) {
      return c.json({ error: 'a record is missing table, id, at or payload' }, 400)
    }
  }
  if (body.records.length === 0) return c.json({ accepted: 0, duplicates: 0 })
  const db = sql()
  const results = await db.transaction((tx) =>
    body.records!.map((r) => tx`insert into sync_records (table_name, id, device, payload, device_at)
      values (${r.table}, ${r.id}, ${body.device!.trim()}, ${JSON.stringify(r.payload)}::jsonb, ${r.at})
      on conflict (table_name, id) do nothing returning id`),
  )
  const accepted = results.filter((rows) => rows.length > 0).length
  return c.json({ accepted, duplicates: body.records.length - accepted })
})

// What the server holds, by table (for checking a sync worked).
app.get('/sync/summary', async (c) => {
  if (!authorised(c.req.header('authorization'))) return c.json({ error: 'unauthorised' }, 401)
  const rows = await sql().query('select table_name, count(*)::int as n from sync_records group by table_name order by table_name')
  return c.json({ tables: rows })
})
