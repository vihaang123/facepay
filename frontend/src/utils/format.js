export const pct = (v) => `${(v * 100).toFixed(1)}%`

// Amounts arrive from the API as decimal strings ("950.00"); they are formatted for display only.
export function formatMoney(amount, currency = 'INR') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return String(amount)
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
}

export const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—')

/** "Today • 6:42 PM", "Yesterday • 9:05 AM", "12 Oct • 4:30 PM": how a payment feed dates things. */
export function formatFeedTime(iso, now = new Date()) {
  if (!iso) return '—'
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase()
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
  return `${label} • ${time}`
}

export const greeting = (now = new Date()) => {
  const h = now.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

// Session / transaction states shown to people. The stored values stay machine-readable.
export const STATUS_LABELS = {
  CREATED: 'Waiting for customer',
  AUTHENTICATED: 'Customer authenticated',
  PAID: 'Successful',
  SUCCESS: 'Successful',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  PENDING: 'Pending',
}
export const PAYABLE_STATUSES = ['CREATED', 'AUTHENTICATED']

export const isPayable = (status) => PAYABLE_STATUSES.includes(status)
