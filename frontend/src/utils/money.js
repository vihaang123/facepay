export const MAX_AMOUNT = 1000000 // the API's own ceiling per payment or request (the backend enforces it too)
/** A positive rupee amount with at most two decimals, as a string. The server validates again; this only saves a round trip. */
export function validateAmount(raw, { max } = {}) {
  const text = String(raw ?? '').trim().replace(/,/g, '')
  if (!text) return 'Enter an amount.'
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return 'Enter an amount like 250 or 250.50.'
  const n = Number(text)
  if (!(n > 0)) return 'The amount must be more than zero.'
  if (max !== undefined && n > max) return `That is more than ${max.toLocaleString('en-IN')}.`
  return null
}

/** Normalises what was typed ("1,250.5") to what is sent ("1250.50"). */
export function toAmountString(raw) {
  const [whole, frac = ''] = String(raw).trim().replace(/,/g, '').split('.')
  return `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(2, '0').slice(0, 2)}`
}

export function newKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
