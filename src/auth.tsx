import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { db, type User } from './db/db'
import { audit } from './db/audit'
import { verifyLogin } from './db/users'

type Auth = {
  user: User | null
  ready: boolean
  locked: boolean // the screen is covered until a PIN is entered; the cart and everything else stay as they were
  login: (userId: string, pin: string) => Promise<boolean> // also the fast user switch: a different user can unlock the screen
  lock: () => void
  logout: () => void
}

const Ctx = createContext<Auth | null>(null)
const KEY = 'pos-user' // sessionStorage: survives a refresh, cleared when the tab closes
const LOCK = 'pos-locked'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [locked, setLocked] = useState(() => sessionStorage.getItem(LOCK) === '1')

  useEffect(() => {
    const id = sessionStorage.getItem(KEY)
    ;(id ? db.users.get(id) : Promise.resolve(undefined)).then((u) => {
      if (u?.active) setUser(u)
      setReady(true)
    })
  }, [])

  const login = async (userId: string, pin: string) => {
    const u = await verifyLogin(userId, pin)
    if (!u) {
      await audit({ userId, action: 'auth.failed' })
      return false
    }
    sessionStorage.setItem(KEY, u.id)
    sessionStorage.removeItem(LOCK)
    // Switching person on a locked screen is logged (who handed over to whom).
    await audit({ userId: u.id, action: 'auth.login', ...(user && user.id !== u.id && { detail: { switchedFrom: user.id } }) })
    setLocked(false)
    setUser(u)
    return true
  }
  const lock = useCallback(() => {
    sessionStorage.setItem(LOCK, '1')
    setLocked(true)
  }, []) // stable, so the idle timer in App is not restarted by every render
  const logout = () => {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(LOCK)
    setLocked(false)
    setUser(null)
  }

  return <Ctx.Provider value={{ user, ready, locked, login, lock, logout }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}
