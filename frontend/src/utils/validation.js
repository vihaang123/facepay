// Client-side checks mirror the backend rules for fast feedback. The server remains
// the source of truth and its messages are shown if they disagree.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[0-9]{7,15}$/

export const validateEmail = (v) => (EMAIL_RE.test((v || '').trim()) ? null : 'Enter a valid email address')

export function validatePassword(v) {
  if (!v || v.length < 8) return 'Password must be at least 8 characters'
  if (v.length > 128) return 'Password must be at most 128 characters'
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return 'Password must contain a letter and a number'
  return null
}

export function validatePhone(v) {
  const cleaned = (v || '').replace(/[\s\-()]/g, '')
  if (cleaned === '') return null // optional
  return PHONE_RE.test(cleaned) ? null : 'Phone must be 7 to 15 digits, optionally starting with +'
}

export const validateRequired = (label) => (v) => ((v || '').trim() ? null : `${label} is required`)

// Runs { field: validatorFn } against values and returns only the failing fields.
export function runValidators(values, validators) {
  const errors = {}
  for (const [field, fn] of Object.entries(validators)) {
    const message = fn(values[field], values)
    if (message) errors[field] = message
  }
  return errors
}
