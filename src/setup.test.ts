import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createBranch, createTerminal, createUser, setActive, updateUser } from './db/setup'
import { db } from './db/db'
import { verifyLogin } from './db/users'

describe('setup', () => {
  it('terminal prefix is normalised, validated and unique', async () => {
    const b = await createBranch('Main')
    const t = await createTerminal(b.id, 'Counter 1', ' t1 ')
    expect(t.invoicePrefix).toBe('T1')
    await expect(createTerminal(b.id, 'Counter 2', 'T1')).rejects.toThrow(/already used/)
    await expect(createTerminal(b.id, 'Counter 2', 'toolong')).rejects.toThrow()
    await expect(createTerminal('nope', 'X', 'T2')).rejects.toThrow()
  })
  it('archives instead of deleting', async () => {
    const b = await createBranch('Old')
    await setActive('branches', b.id, false)
    expect((await db.branches.get(b.id))?.active).toBe(false)
  })
  it('the last active owner cannot be archived or demoted', async () => {
    await db.users.clear()
    const o = await createUser('Owner', 'owner', '1111')
    await expect(setActive('users', o.id, false)).rejects.toThrow(/owner/)
    await expect(updateUser(o.id, { name: 'Owner', role: 'cashier' })).rejects.toThrow(/owner/)
    const o2 = await createUser('Owner 2', 'owner', '2222')
    await setActive('users', o.id, false) // fine now: another owner exists
    expect((await db.users.get(o.id))?.active).toBe(false)
    await expect(setActive('users', o2.id, false)).rejects.toThrow(/owner/)
  })
  it('PIN reset works; blank PIN keeps the old one', async () => {
    const u = await createUser('Cy', 'cashier', '1357')
    await updateUser(u.id, { name: 'Cy', role: 'cashier' })
    expect(await verifyLogin(u.id, '1357')).not.toBeNull()
    await updateUser(u.id, { name: 'Cy', role: 'supervisor', pin: '9753' })
    expect(await verifyLogin(u.id, '1357')).toBeNull()
    expect((await verifyLogin(u.id, '9753'))?.role).toBe('supervisor')
  })
})
