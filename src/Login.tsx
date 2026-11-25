import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from './auth'
import { createUser } from './db/setup'
import { listActiveUsers } from './db/users'
import { isValidPin } from './lib/pin'
import type { User } from './db/db'

export default function Login() {
  const users = useLiveQuery(listActiveUsers, [])
  if (!users) return null // still loading
  return (
    <main className="login">
      <div className="login-card">
        <h1>DEMO POS</h1>
        {users.length === 0 ? <FirstRun /> : <SignIn users={users} />}
      </div>
    </main>
  )
}

/** No users yet (no seed data): create the owner. */
function FirstRun() {
  const { login } = useAuth()
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const u = await createUser(name, 'owner', pin)
      await login(u.id, pin)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>Create the owner account</h2>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label>
        PIN (4–6 digits)
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={!name.trim() || !isValidPin(pin)}>Create owner account</button>
    </form>
  )
}

function SignIn({ users }: { users: User[] }) {
  const { login } = useAuth()
  const [selected, setSelected] = useState<User | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!selected) return
    if (!(await login(selected.id, pin))) {
      setError('Wrong PIN. Try again.')
      setPin('')
    }
  }

  const typePin = (next: string) => {
    setPin(next.replace(/\D/g, '').slice(0, 6))
    setError('')
  }

  if (!selected) {
    return (
      <section>
        <h2>Who is signing in?</h2>
        <p className="hint">Tap your name to enter your PIN.</p>
        <ul className="users">
          {users.map((u) => (
            <li key={u.id}>
              <button onClick={() => { setSelected(u); setPin(''); setError('') }}>
                <span className="avatar" aria-hidden="true">{initials(u.name)}</span>
                <span className="who">
                  <span className="name">{u.name}</span>
                  <span className="role">{u.role}</span>
                </span>
                <span className="chev" aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <form onSubmit={submit}>
      <button type="button" className="link" onClick={() => setSelected(null)}>‹ Change user</button>
      <div className="selected">
        <span className="avatar lg" aria-hidden="true">{initials(selected.name)}</span>
        <h2>{selected.name}</h2>
        <span className="role">{selected.role}</span>
      </div>
      <label>
        Enter your PIN
        <input
          className="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          aria-invalid={!!error}
          onChange={(e) => typePin(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button type="button" key={d} onClick={() => typePin(pin + d)}>{d}</button>
        ))}
        <button type="button" onClick={() => typePin('')} aria-label="Clear PIN">Clear</button>
        <button type="button" onClick={() => typePin(pin + '0')}>0</button>
        <button type="button" onClick={() => typePin(pin.slice(0, -1))} aria-label="Delete last digit">⌫</button>
      </div>
      <button className="primary" disabled={!isValidPin(pin)}>Sign in</button>
    </form>
  )
}

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')
