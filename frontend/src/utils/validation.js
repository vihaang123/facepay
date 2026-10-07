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

const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/

export function validatePayment({ amount, orderReference }) {
  const errors = {}
  if (!AMOUNT_RE.test(amount.trim()) || Number(amount) <= 0 || Number(amount) > 1_000_000) {
    errors.amount = 'Enter an amount between 0.01 and 1,000,000 with at most 2 decimals.'
  }
  if (!orderReference.trim()) errors.orderReference = 'Enter an order or reference number.'
  else if (orderReference.trim().length > 80) errors.orderReference = 'Use at most 80 characters.'
  return errors
}

