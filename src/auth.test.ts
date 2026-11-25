import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { checkPin, hashPin, isValidPin } from './lib/pin'
import { createUser } from './db/setup'
import { listActiveUsers, verifyLogin } from './db/users'
import { db } from './db/db'

describe('login', () => {
  it('PINs are 4–6 digits', () => {
    expect(isValidPin('1234')).toBe(true)
    expect(isValidPin('123')).toBe(false)
    expect(isValidPin('1234567')).toBe(false)
    expect(isValidPin('12a4')).toBe(false)
  })
  it('hash is salted and verifies only the right PIN', async () => {
    const a = await hashPin('1234')
    expect(a).not.toBe(await hashPin('1234'))
    expect(await checkPin('1234', a)).toBe(true)
    expect(await checkPin('4321', a)).toBe(false)
  })
  it('right PIN signs in, wrong PIN and archived users do not', async () => {
    const u = await createUser('Ana', 'cashier', '2468')
    expect((await verifyLogin(u.id, '2468'))?.name).toBe('Ana')
    expect(await verifyLogin(u.id, '0000')).toBeNull()
    await db.users.update(u.id, { active: false })
    expect(await verifyLogin(u.id, '2468')).toBeNull()
    expect((await listActiveUsers()).some((x) => x.id === u.id)).toBe(false)
  })
  it('rejects a bad PIN on create', async () => {
    await expect(createUser('Bo', 'cashier', '12')).rejects.toThrow()
  })
})
