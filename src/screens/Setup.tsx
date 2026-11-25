import { useAuth } from '../auth'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db/db'
import { createBranch, createTerminal, createUser, setActive, updateUser } from '../db/setup'
import { ROLES, type Role } from '../lib/roles'
import { isValidPin } from '../lib/pin'
import { Err, useAction } from '../ui'

function ArchiveButton({ table, id, active }: { table: 'branches' | 'terminals' | 'users'; id: string; active: boolean }) {
  const { error, run } = useAction()
  return (
    <>
      <button onClick={() => run(() => setActive(table, id, !active))}>{active ? 'Archive' : 'Restore'}</button>
      <Err msg={error} />
    </>
  )
}

export default function Setup() {
  return (
    <>
      <h2>Setup</h2>
      <Branches />
      <Terminals />
      <Users />
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Branches() {
  const branches = useLiveQuery(() => db.branches.toArray(), [])
  const [name, setName] = useState('')
  const { error, run } = useAction()
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => createBranch(name))) setName('')
  }
  return (
    <Section title="Branches">
      <ul>
        {branches?.map((b) => (
          <li key={b.id} className={b.active ? '' : 'archived'}>
            {b.name} <ArchiveButton table="branches" id={b.id} active={b.active} />
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="row">
        <input aria-label="Branch name" placeholder="Branch name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()}>Add branch</button>
      </form>
      <Err msg={error} />
    </Section>
  )
}

function Terminals() {
  const branches = useLiveQuery(() => db.branches.toArray(), [])
  const terminals = useLiveQuery(() => db.terminals.toArray(), [])
  const [branchId, setBranchId] = useState('')
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const { error, run } = useAction()
  const activeBranches = branches?.filter((b) => b.active) ?? []
  const branchName = (id: string) => branches?.find((b) => b.id === id)?.name ?? '?'
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => createTerminal(branchId || activeBranches[0].id, name, prefix))) {
      setName('')
      setPrefix('')
    }
  }
  return (
    <Section title="Terminals">
      <ul>
        {terminals?.map((t) => (
          <li key={t.id} className={t.active ? '' : 'archived'}>
            {t.name} <small>{t.invoicePrefix} · {branchName(t.branchId)}</small>{' '}
            <ArchiveButton table="terminals" id={t.id} active={t.active} />
          </li>
        ))}
      </ul>
      {activeBranches.length === 0 ? (
        <p>Add a branch first.</p>
      ) : (
        <form onSubmit={add} className="row">
          <select aria-label="Branch" value={branchId || activeBranches[0].id} onChange={(e) => setBranchId(e.target.value)}>
            {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input aria-label="Terminal name" placeholder="Terminal name" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Invoice prefix" placeholder="Prefix (T1)" size={8} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <button disabled={!name.trim() || !prefix.trim()}>Add terminal</button>
        </form>
      )}
      <Err msg={error} />
    </Section>
  )
}

function Users() {
  const users = useLiveQuery(() => db.users.toArray(), [])
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('cashier')
  const [pin, setPin] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const { error, run } = useAction()
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => createUser(name, role, pin))) {
      setName('')
      setPin('')
    }
  }
  return (
    <Section title="Staff">
      <ul>
        {users?.map((u) =>
          editing === u.id ? (
            <li key={u.id}><UserEditor user={u} done={() => setEditing(null)} /></li>
          ) : (
            <li key={u.id} className={u.active ? '' : 'archived'}>
              {u.name} <small>{u.role}</small> <button onClick={() => setEditing(u.id)}>Edit</button>{' '}
              <ArchiveButton table="users" id={u.id} active={u.active} />
            </li>
          ),
        )}
      </ul>
      <form onSubmit={add} className="row">
        <input aria-label="Staff name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <RoleSelect value={role} onChange={setRole} />
        <PinInput label="PIN" value={pin} onChange={setPin} />
        <button disabled={!name.trim() || !isValidPin(pin)}>Add staff</button>
      </form>
      <Err msg={error} />
    </Section>
  )
}

const RoleSelect = ({ value, onChange }: { value: Role; onChange: (r: Role) => void }) => (
  <select aria-label="Role" value={value} onChange={(e) => onChange(e.target.value as Role)}>
    {ROLES.map((r) => <option key={r}>{r}</option>)}
  </select>
)

const PinInput = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
  <input
    aria-label={label}
    placeholder={label}
    type="password"
    inputMode="numeric"
    autoComplete="off"
    size={8}
    value={value}
    onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
  />
)

function UserEditor({ user, done }: { user: User; done: () => void }) {
  const { user: me } = useAuth()
  const [name, setName] = useState(user.name)
  const [role, setRole] = useState<Role>(user.role)
  const [pin, setPin] = useState('')
  const { error, run } = useAction()
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => updateUser(user.id, { name, role, pin: pin || undefined }, me?.id))) done()
  }
  return (
    <form onSubmit={save} className="row">
      <input aria-label="Staff name" value={name} onChange={(e) => setName(e.target.value)} />
      <RoleSelect value={role} onChange={setRole} />
      <PinInput label="New PIN (optional)" value={pin} onChange={setPin} />
      <button disabled={!name.trim() || (pin !== '' && !isValidPin(pin))}>Save</button>
      <button type="button" onClick={done}>Cancel</button>
      <Err msg={error} />
    </form>
  )
}
