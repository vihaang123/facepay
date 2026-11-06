// Indian mobile numbers and the 6-digit app passcode. These mirror the server's rules for fast feedback; the server decides.

/** The 10 national digits, or null. Accepts spaces, dashes, +91, 91 and a leading 0 the way people type and paste numbers. */
export function normalizeMobile(raw) {
  let text = String(raw ?? '').replace(/[\s\-().]/g, '')
  if (text.startsWith('+91')) text = text.slice(3)
  else if (text.length === 12 && text.startsWith('91')) text = text.slice(2)
  else if (text.length === 11 && text.startsWith('0')) text = text.slice(1)
  return /^[6-9][0-9]{9}$/.test(text) ? text : null
}

export const validateMobile = (v) => (normalizeMobile(v) ? null : 'Enter a valid 10-digit mobile number.')

export const maskMobile = (digits) => (digits ? `+91 •••••${digits.slice(-5)}` : '')
export const formatMobile = (digits) => (digits ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : '')

const WEAK = new Set(['123456', '654321', '123123', '112233', '121212', '696969', '159753', '246810', '135790', '000000', '111111'])

export function validatePasscode(v) {
  const p = v ?? ''
  if (!/^[0-9]{6}$/.test(p)) return 'The passcode must be exactly 6 digits.'
  const d = [...p].map(Number)
  const steps = new Set(d.slice(1).map((x, i) => x - d[i]))
  const sequence = steps.size === 1 && (steps.has(1) || steps.has(-1))
  if (new Set(p).size === 1 || sequence || WEAK.has(p) || p.slice(0, 3) === p.slice(3)) {
    return 'Choose a passcode that is harder to guess (not 123456, 111111 or a repeating pattern).'
  }
  return null
}
