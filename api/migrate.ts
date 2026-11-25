import { sql } from './db.ts'
import { SCHEMA } from './schema.ts'

const db = sql()
for (const statement of SCHEMA) await db.query(statement)
const [{ n }] = await db.query('select count(*)::int as n from information_schema.tables where table_name = $1', ['sync_records'])
console.log(`schema ready (sync_records present: ${n === 1})`)
