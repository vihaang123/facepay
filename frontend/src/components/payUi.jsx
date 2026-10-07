import { STATUS_LABELS, formatDateTime, formatMoney } from '../utils/format'
import { Logo } from './ui'

const BADGE = {
  SUCCESS: 'bg-emerald-50 text-emerald-800 ring-emerald-200', PAID: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  FAILED: 'bg-rose-50 text-rose-800 ring-rose-200',
  CREATED: 'bg-amber-50 text-amber-900 ring-amber-200', AUTHENTICATED: 'bg-amber-50 text-amber-900 ring-amber-200', PENDING: 'bg-amber-50 text-amber-900 ring-amber-200',
  EXPIRED: 'bg-slate-100 text-slate-700 ring-slate-200', CANCELLED: 'bg-slate-100 text-slate-700 ring-slate-200',
}

/** Always text, never colour alone. */
export function StatusBadge({ status, label }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[status] ?? 'bg-slate-100 text-slate-700 ring-slate-200'}`}>
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-2.5 text-sm last:border-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  )
}

/** A polished receipt. Everything shown comes from the server's transaction record. */
export function Receipt({ receipt, children }) {
  const ok = receipt.status === 'SUCCESS'
  return (
    <article aria-label="Payment receipt" className="print-card mx-auto w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className={`px-6 py-5 text-center ${ok ? 'bg-emerald-50' : 'bg-rose-50'}`}>
        <Logo className="text-base" />
        <p className={`mt-3 text-sm font-bold tracking-widest ${ok ? 'text-emerald-800' : 'text-rose-800'}`}>
          {ok ? 'PAYMENT SUCCESSFUL ✓' : `PAYMENT ${receipt.status}`}
        </p>
        <p className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">{formatMoney(receipt.amount, receipt.currency)}</p>
        <p className="mt-2 text-xs text-slate-700">Simulated payment: no real money moved</p>
      </div>
      <dl className="px-6 py-3">
        <Row label="From">{receipt.payer_name}</Row>
        <Row label="To">{receipt.merchant_name}</Row>
        {receipt.order_reference && <Row label="Order">{receipt.order_reference}</Row>}
        {receipt.description && <Row label="Details">{receipt.description}</Row>}
        <Row label="Payment method">{receipt.payment_method === 'FACE_PAY' ? 'FacePay' : receipt.payment_method}</Row>
        <Row label="Transaction ID"><span className="font-mono">{receipt.transaction_id}</span></Row>
        <Row label="Status">{receipt.status}</Row>
        <Row label="Date and time">{formatDateTime(receipt.timestamp)}</Row>
      </dl>
      {children && <div className="no-print flex flex-wrap justify-center gap-3 border-t border-slate-100 px-6 py-4">{children}</div>}
    </article>
  )
}
