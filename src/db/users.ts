import { db, type User } from './db'
import { newId } from '../lib/id'
import { checkPin, hashPin, isValidPin } from '../lib/pin'
import type { Role } from '../lib/roles'

export async function createUser(name: string, role: Role, pin: string): Promise<User> {
  if (!name.trim()) throw new Error('Name is required')
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 6 digits')
  const user: User = { id: newId(), name: name.trim(), role, pinHash: await hashPin(pin), active: true }
  await db.users.add(user)
  return user
}

export async function listActiveUsers(): Promise<User[]> {
  return (await db.users.toArray()).filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name))
}

/** Returns the user if the PIN matches an active user, otherwise null. */
export async function verifyLogin(userId: string, pin: string): Promise<User | null> {
  const user = await db.users.get(userId)
  if (!user || !user.active) return null
  return (await checkPin(pin, user.pinHash)) ? user : null
}
