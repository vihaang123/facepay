/** Accepts a pasted checkout link or the session id inside it. Only the id is used; the server decides everything else. */
export function sessionIdFrom(text) {
  const value = text.trim()
  const fromPath = value.match(/\/checkout\/([A-Za-z0-9_-]+)/)
  if (fromPath) return fromPath[1]
  return /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : null
}

