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
      <h1>DEMO POS</h1>
      {users.length === 0 ? <FirstRun /> : <SignIn users={users} />}
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
      <button disabled={!name.trim() || !isValidPin(pin)}>Create account</button>
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

  if (!selected) {
    return (
      <section>
        <h2>Who is signing in?</h2>
        <ul className="users">
          {users.map((u) => (
            <li key={u.id}>
              <button onClick={() => { setSelected(u); setPin(''); setError('') }}>
                {u.name} <small>{u.role}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <form onSubmit={submit}>
      <h2>{selected.name}</h2>
      <label>
        PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={!isValidPin(pin)}>Sign in</button>{' '}
      <button type="button" onClick={() => setSelected(null)}>Back</button>
    </form>
  )
}
