// One generic table for synced records for now: every row a device made is stored once, keyed by (table, device-made id).
// Real per-table schemas can replace this later; the idempotency rule stays: the same id twice is ignored.
export const SCHEMA = [
  `create table if not exists sync_records (
     table_name  text        not null,
     id          text        not null,
     device      text        not null,
     payload     jsonb       not null,
     device_at   timestamptz not null,
     received_at timestamptz not null default now(),
     primary key (table_name, id)
   )`,
  `create index if not exists sync_records_received_idx on sync_records (received_at)`,
]
