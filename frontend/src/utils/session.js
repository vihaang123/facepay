// Persists the access token across reloads. Every access is guarded: storage can be
// unavailable (private mode, blocked cookies) and the app must still work in-memory.
// Trade-off: localStorage is readable by any script on the page (XSS risk). Acceptable
// for this prototype; a production system would use httpOnly cookies.
const KEY = 'facepay.session'

export function loadSession() {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s?.token || !s?.role || typeof s.expiresAt !== 'number') return null
    if (Date.now() >= s.expiresAt) {
      clearSession()
      return null
    }
    return s
  } catch {
    return null
  }
}

export function saveSession({ token, role, expiresInSeconds }) {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token, role, expiresAt: Date.now() + expiresInSeconds * 1000 }),
    )
  } catch {
    // storage unavailable: session lasts until reload
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
