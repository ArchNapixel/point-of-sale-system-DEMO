import { db, type User } from './db'
import { checkPin } from '../lib/pin'

export async function listActiveUsers(): Promise<User[]> {
  return (await db.users.toArray()).filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name))
}

/** Returns the user if the PIN matches an active user, otherwise null. */
export async function verifyLogin(userId: string, pin: string): Promise<User | null> {
  const user = await db.users.get(userId)
  if (!user || !user.active) return null
  return (await checkPin(pin, user.pinHash)) ? user : null
}
