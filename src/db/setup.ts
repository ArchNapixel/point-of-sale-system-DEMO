import { db, type Branch, type Terminal, type User } from './db'
import { newId } from '../lib/id'
import { hashPin, isValidPin } from '../lib/pin'
import type { Role } from '../lib/roles'

export async function createBranch(name: string): Promise<Branch> {
  if (!name.trim()) throw new Error('Branch name is required')
  const b: Branch = { id: newId(), name: name.trim(), active: true }
  await db.branches.add(b)
  return b
}

/** Prefix starts each invoice number (e.g. T1-000123), so it must be unique per terminal. */
export async function createTerminal(branchId: string, name: string, prefix: string): Promise<Terminal> {
  const p = prefix.trim().toUpperCase()
  if (!name.trim()) throw new Error('Terminal name is required')
  if (!/^[A-Z0-9]{1,4}$/.test(p)) throw new Error('Prefix must be 1–4 letters or digits')
  if (!(await db.branches.get(branchId))) throw new Error('Pick a branch')
  if ((await db.terminals.toArray()).some((t) => t.invoicePrefix === p)) throw new Error(`Prefix ${p} is already used`)
  const t: Terminal = { id: newId(), branchId, name: name.trim(), invoicePrefix: p, active: true }
  await db.terminals.add(t)
  return t
}

/** There must always be at least one active owner, or nobody can run setup. */
async function assertOwnerRemains(userId: string, willBeOwner: boolean) {
  if (willBeOwner) return
  const others = (await db.users.toArray()).filter((u) => u.id !== userId && u.active && u.role === 'owner')
  if (others.length === 0) throw new Error('Keep at least one active owner')
}

export async function createUser(name: string, role: Role, pin: string): Promise<User> {
  if (!name.trim()) throw new Error('Name is required')
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 6 digits')
  const u: User = { id: newId(), name: name.trim(), role, pinHash: await hashPin(pin), active: true }
  await db.users.add(u)
  return u
}

export async function updateUser(id: string, patch: { name: string; role: Role; pin?: string }) {
  const u = await db.users.get(id)
  if (!u) throw new Error('User not found')
  if (!patch.name.trim()) throw new Error('Name is required')
  if (patch.pin && !isValidPin(patch.pin)) throw new Error('PIN must be 4 to 6 digits')
  if (u.active) await assertOwnerRemains(id, patch.role === 'owner')
  await db.users.update(id, {
    name: patch.name.trim(),
    role: patch.role,
    ...(patch.pin ? { pinHash: await hashPin(patch.pin) } : {}),
  })
}

/** Archive or restore. Never delete (design rule 3). */
export async function setActive(table: 'branches' | 'terminals' | 'users', id: string, active: boolean) {
  if (table === 'users' && !active) {
    const u = await db.users.get(id)
    if (u?.role === 'owner') await assertOwnerRemains(id, false)
  }
  await db[table].update(id, { active })
}
