import { neon } from '@neondatabase/serverless'

// The pooled connection string from Neon. It is a password: it lives in .env.local (git-ignored) or the host's environment variables,
// and only this server reads it. The browser app never connects to the database.
export function sql() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set. Run `neon deploy` (it writes .env.local) or set it in the host environment.')
  return neon(url) // HTTP driver: one request per query, fine for a serverless or long-running Node host
}
