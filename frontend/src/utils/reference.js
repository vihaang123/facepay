// Why money is being asked for. Mirrors backend/app/core/purposes.py so people see the problem before sending; the server
// repeats every check and is the one that decides.
export const PURPOSES = [
  ['GOODS', 'Goods or shopping'],
  ['SERVICE', 'Service or work done'],
  ['BILL_SPLIT', 'Splitting a bill'],
  ['REPAYMENT', 'Repaying money lent'],
  ['RENT', 'Rent or deposit'],
  ['OTHER', 'Something else'],
]
export const purposeLabel = (code) => PURPOSES.find(([c]) => c === code)?.[1] ?? null

export const MIN_REFERENCE = 3
export const MAX_REFERENCE = 80
const SCAM = /\b(otp|cvv|upi\s*pin|atm\s*pin|password|lottery|lucky\s*draw|prize|gift\s*card|crypto|investment\s*return|kyc\s*update)\b/i

export function validatePurpose(code) {
  return PURPOSES.some(([c]) => c === code) ? null : 'Choose what the money is for.'
}

export function validateReference(value) {
  const text = (value ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (!text) return 'Say what this is for, for example “Order #14 groceries”.'
  if (text.length < MIN_REFERENCE) return 'The reference is too short. Say what this is for in a few words.'
  if (text.length > MAX_REFERENCE) return `Keep the reference to ${MAX_REFERENCE} characters or fewer.`
  const letters = [...text.toLowerCase()].filter((c) => c.toLowerCase() !== c.toUpperCase())
  if (letters.length < 3 || new Set(letters).size < 2) return 'Write a real reason in words, for example “Dinner split, Friday”.'
  if (SCAM.test(text)) return 'Do not ask for money for OTPs, PINs, passwords, prizes or gift cards. Describe the real reason.'
  return null
}
