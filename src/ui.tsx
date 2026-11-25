import { useState } from 'react'

/** Runs an action and keeps its error message for display (validation errors come from the db/ modules). */
export function useAction() {
  const [error, setError] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setError('')
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }
  return { error, run }
}

export const Err = ({ msg }: { msg: string }) => (msg ? <p role="alert">{msg}</p> : null)
