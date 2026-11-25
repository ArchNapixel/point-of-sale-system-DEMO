import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { db, type User } from './db/db'
import { verifyLogin } from './db/users'

type Auth = {
  user: User | null
  ready: boolean
  login: (userId: string, pin: string) => Promise<boolean>
  logout: () => void
}

const Ctx = createContext<Auth | null>(null)
const KEY = 'pos-user' // sessionStorage: survives a refresh, cleared when the tab closes

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const id = sessionStorage.getItem(KEY)
    ;(id ? db.users.get(id) : Promise.resolve(undefined)).then((u) => {
      if (u?.active) setUser(u)
      setReady(true)
    })
  }, [])

  const login = async (userId: string, pin: string) => {
    const u = await verifyLogin(userId, pin)
    if (!u) return false
    sessionStorage.setItem(KEY, u.id)
    setUser(u)
    return true
  }
  const logout = () => {
    sessionStorage.removeItem(KEY)
    setUser(null)
  }

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}
