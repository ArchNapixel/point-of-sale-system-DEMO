import { useAuth } from './auth'
import Login from './Login'
import { DEMO_FOOTER } from './lib/receipt'

export default function App() {
  const { user, ready, logout } = useAuth()
  if (!ready) return null
  if (!user) return <Login />

  return (
    <main>
      <header>
        <strong>DEMO POS</strong> · {user.name} ({user.role}) <button onClick={logout}>Sign out</button>
      </header>
      <p>Signed in. Screens come next (1A: shell, setup, settings).</p>
      <p>{DEMO_FOOTER}</p>
    </main>
  )
}
