import { STATUS_LABELS, formatDateTime, formatMoney } from '../utils/format'

const BADGE = {
  SUCCESS: 'bg-emerald-50 text-emerald-700', PAID: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-rose-50 text-rose-700',
  CREATED: 'bg-amber-50 text-amber-700', AUTHENTICATED: 'bg-amber-50 text-amber-700', PENDING: 'bg-amber-50 text-amber-700',
  EXPIRED: 'bg-slate-100 text-slate-600', CANCELLED: 'bg-slate-100 text-slate-600',
}

/** Always text, never colour alone. */
export function StatusBadge({ status, label }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-2 text-sm last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  )
}

/** A polished receipt. Everything shown comes from the server's transaction record. */
export function Receipt({ receipt, children }) {
  const ok = receipt.status === 'SUCCESS'
  return (
    <article aria-label="Payment receipt" className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6">
      <div className="text-center">
        <p className={`text-sm font-bold tracking-widest ${ok ? 'text-emerald-700' : 'text-rose-700'}`}>
          {ok ? 'PAYMENT SUCCESSFUL ✓' : `PAYMENT ${receipt.status}`}
        </p>
        <p className="mt-2 text-4xl font-bold tracking-tight">{formatMoney(receipt.amount, receipt.currency)}</p>
        <p className="mt-1 text-xs text-slate-500">Simulated payment: no real money moved</p>
      </div>
      <dl className="mt-5">
        <Row label="From">{receipt.payer_name}</Row>
        <Row label="To">{receipt.merchant_name}</Row>
        {receipt.order_reference && <Row label="Order">{receipt.order_reference}</Row>}
        <Row label="Payment method">{receipt.payment_method === 'FACE_PAY' ? 'FacePay' : receipt.payment_method}</Row>
        <Row label="Transaction ID"><span className="font-mono">{receipt.transaction_id}</span></Row>
        <Row label="Status">{receipt.status}</Row>
        <Row label="Timestamp">{formatDateTime(receipt.timestamp)}</Row>
      </dl>
      {children && <div className="mt-5 flex flex-wrap justify-center gap-3">{children}</div>}
    </article>
  )
}
