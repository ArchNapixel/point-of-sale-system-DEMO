import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getSetting } from './db/settings'
import LockScreen from './LockScreen'
import Clock from './screens/Clock'
import { useAuth } from './auth'
import Login from './Login'
import Settings from './screens/Settings'
import Setup from './screens/Setup'
import { can } from './lib/roles'
import { DEMO_FOOTER } from './lib/receipt'

import Shift from './screens/Shift'
import Menu from './screens/Menu'
import Order from './screens/Order'
import Orders from './screens/Orders'
import Queue from './screens/Queue'
import Promos from './screens/Promos'
import Reports from './screens/Reports'

type Tab = 'shift' | 'order' | 'orders' | 'queue' | 'promos' | 'reports' | 'clock' | 'menu' | 'setup' | 'settings'

export default function App() {
  const { user, ready, locked, lock, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('shift')
  const lockMinutes = useLiveQuery(() => getSetting('autoLockMinutes'), [])

  // Auto-lock: any touch or key restarts the timer. When it runs out the screen asks for a PIN; the cart is kept.
  useEffect(() => {
    if (!user || locked || !lockMinutes) return
    let t = setTimeout(lock, lockMinutes * 60_000)
    const reset = () => { clearTimeout(t); t = setTimeout(lock, lockMinutes * 60_000) }
    const events = ['pointerdown', 'keydown']
    events.forEach((e) => window.addEventListener(e, reset))
    return () => { clearTimeout(t); events.forEach((e) => window.removeEventListener(e, reset)) }
  }, [user?.id, locked, lockMinutes, lock])

  if (!ready) return null
  if (!user) return <Login />
  if (locked) return <LockScreen />

  // Screens a role can't use are not shown at all. Add new screens here as they ship.
  const tabs: { id: Tab; label: string }[] = []
  if (can(user.role, 'openShift') || can(user.role, 'openDay')) tabs.push({ id: 'shift', label: 'Shift' })
  if (can(user.role, 'sell')) tabs.push({ id: 'order', label: 'Order' })
  if (can(user.role, 'sell')) tabs.push({ id: 'orders', label: 'Orders' })
  if (can(user.role, 'viewQueue')) tabs.push({ id: 'queue', label: 'Queue' })
  if (can(user.role, 'editPrices') || can(user.role, 'markSoldOut')) tabs.push({ id: 'menu', label: 'Menu' })
  tabs.push({ id: 'clock', label: 'Clock' })
  if (can(user.role, 'viewReports')) tabs.push({ id: 'reports', label: 'Reports' })
  if (can(user.role, 'editPrices')) tabs.push({ id: 'promos', label: 'Promos' })
  if (can(user.role, 'manageSetup')) tabs.push({ id: 'setup', label: 'Setup' }, { id: 'settings', label: 'Settings' })
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id

  return (
    <>
      <header className="shell">
        <strong>DEMO POS</strong>
        <nav>
          {tabs.map((t) => (
            <button key={t.id} aria-current={t.id === current ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span>
          {user.name} <small>({user.role})</small> <button onClick={lock}>Switch user</button> <button onClick={logout}>Sign out</button>
        </span>
      </header>
      <main>
        {!current && <p>Nothing here for your role yet.</p>}
        {current === 'shift' && <Shift />}
        {current === 'order' && <Order />}
        {current === 'orders' && <Orders />}
        {current === 'queue' && <Queue />}
        {current === 'promos' && <Promos />}
        {current === 'reports' && <Reports />}
        {current === 'clock' && <Clock />}
        {current === 'menu' && <Menu />}
        {current === 'setup' && <Setup />}
        {current === 'settings' && <Settings />}
      </main>
      <footer><small>{DEMO_FOOTER}</small></footer>
    </>
  )
}
