// ponytail: salted SHA-256 of a short PIN. A 4–6 digit PIN is brute-forceable by anyone who can read the
// local DB, so this only stops casual snooping. Upgrade to server-side checks + lockout when the API exists.
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

const digest = async (salt: string, pin: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`)))

export const isValidPin = (pin: string) => /^\d{4,6}$/.test(pin)

/** Returns "salt:hash". */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomUUID()
  return `${salt}:${await digest(salt, pin)}`
}

export async function checkPin(pin: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  return (await digest(salt, pin)) === hash
}
