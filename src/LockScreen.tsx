import { useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from './auth'
import { listActiveUsers } from './db/users'
import { isValidPin } from './lib/pin'

/** Shown after idle time or "Switch user". The current cart is kept (it autosaves); a PIN is needed to carry on, as the same or another person. */
export default function LockScreen() {
  const { user, login, logout } = useAuth()
  const users = useLiveQuery(listActiveUsers, [])
  const [who, setWho] = useState(user?.id ?? '')
  const [picking, setPicking] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  if (!users) return null
  const chosen = users.find((u) => u.id === who)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!chosen) return
    if (!(await login(chosen.id, pin))) {
      setError('Wrong PIN. Try again.')
      setPin('')
    }
  }

  return (
    <main className="login">
      <h1>Locked</h1>
      {picking || !chosen ? (
        <section>
          <h2>Who is it?</h2>
          <ul className="users">
            {users.map((u) => (
              <li key={u.id}><button onClick={() => { setWho(u.id); setPicking(false); setPin(''); setError('') }}>{u.name} <small>{u.role}</small></button></li>
            ))}
          </ul>
        </section>
      ) : (
        <form onSubmit={submit}>
          <h2>{chosen.name}</h2>
          <label>
            PIN
            <input type="password" inputMode="numeric" autoComplete="off" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </label>
          {error && <p role="alert">{error}</p>}
          <button disabled={!isValidPin(pin)}>Unlock</button>{' '}
          <button type="button" onClick={() => setPicking(true)}>Switch user</button>{' '}
          <button type="button" onClick={logout}>Sign out</button>
        </form>
      )}
    </main>
  )
}
