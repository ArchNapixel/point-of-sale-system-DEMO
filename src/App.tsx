import { useState } from 'react'
import { useAuth } from './auth'
import Login from './Login'
import Settings from './screens/Settings'
import Setup from './screens/Setup'
import { can } from './lib/roles'
import { DEMO_FOOTER } from './lib/receipt'

import Shift from './screens/Shift'

type Tab = 'shift' | 'setup' | 'settings'

export default function App() {
  const { user, ready, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('shift')
  if (!ready) return null
  if (!user) return <Login />

  // Screens a role can't use are not shown at all. Add new screens here as they ship.
  const tabs: { id: Tab; label: string }[] = []
  if (can(user.role, 'openShift') || can(user.role, 'openDay')) tabs.push({ id: 'shift', label: 'Shift' })
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
          {user.name} <small>({user.role})</small> <button onClick={logout}>Sign out</button>
        </span>
      </header>
      <main>
        {!current && <p>Nothing here for your role yet.</p>}
        {current === 'shift' && <Shift />}
        {current === 'setup' && <Setup />}
        {current === 'settings' && <Settings />}
      </main>
      <footer><small>{DEMO_FOOTER}</small></footer>
    </>
  )
}
