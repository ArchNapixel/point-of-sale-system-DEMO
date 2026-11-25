import type { Terminal } from './db'

/** localStorage key holding which terminal this browser/tablet is. */
export const DEVICE_KEY = 'pos-terminal'

/** This device's terminal: the stored one if it's still active, otherwise the first active terminal. */
export const resolveTerminal = (terminals: Terminal[], stored: string | null): Terminal | undefined =>
  terminals.find((t) => t.id === stored) ?? terminals[0]
