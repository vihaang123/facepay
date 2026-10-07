export const pct = (v) => `${(v * 100).toFixed(1)}%`

// Amounts arrive from the API as decimal strings ("950.00"); they are formatted for display only.
export function formatMoney(amount, currency = 'INR') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return String(amount)
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
}

export const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—')

// Session / transaction states shown to people. The stored values stay machine-readable.
export const STATUS_LABELS = {
  CREATED: 'Waiting for customer',
  AUTHENTICATED: 'Customer authenticated',
  PAID: 'Paid',
  SUCCESS: 'Success',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  PENDING: 'Pending',
}
export const PAYABLE_STATUSES = ['CREATED', 'AUTHENTICATED']

export const isPayable = (status) => PAYABLE_STATUSES.includes(status)
