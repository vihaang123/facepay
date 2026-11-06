import { Link } from 'react-router-dom'
import { SIMULATION_NOTICE } from '../utils/demo'
import { STATUS_LABELS, formatDateTime, formatFeedTime, formatMoney } from '../utils/format'
import Icon from './Icon'
import { Avatar, Logo } from './ui'

// One status vocabulary for the whole product: an icon AND a word, never colour alone.
const STATUS = {
  success: { icon: 'check', cls: 'bg-success-soft text-success-ink ring-success-line' },
  pending: { icon: 'pending', cls: 'bg-warning-soft text-warning-ink ring-warning-line' },
  failed: { icon: 'x', cls: 'bg-danger-soft text-danger-ink ring-danger-line' },
  expired: { icon: 'hourglass', cls: 'bg-sunken text-fg ring-line' },
  cancelled: { icon: 'x', cls: 'bg-sunken text-fg ring-line' },
}
const KIND = {
  SUCCESS: 'success', PAID: 'success', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled',
  CREATED: 'pending', AUTHENTICATED: 'pending', PENDING: 'pending', DECLINED: 'cancelled',
}

export function StatusBadge({ status, label }) {
  const s = STATUS[KIND[status] ?? 'cancelled']
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${s.cls}`}>
      <Icon name={s.icon} className="h-3 w-3" strokeWidth="2.4" />
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-3 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right font-semibold">{children}</dd>
    </div>
  )
}

/** The amount, large. `testid` keeps tests and browser checks pointed at the right number. */
export function Amount({ value, currency, className = 'text-5xl', ...props }) {
  return <p className={`amount font-bold ${className}`} {...props}>{formatMoney(value, currency)}</p>
}

/** Pill that keeps the prototype honest on every payment screen. */
export function SimulatedTag({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning-ink ring-1 ring-inset ring-warning-line ${className}`}>
      Simulated payment
    </span>
  )
}

/** Merchant identity at the top of checkout screens: initials avatar and name. */
export function MerchantHeader({ name, caption = 'Pay to' }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar name={name} size="h-12 w-12 text-base" />
      <div className="min-w-0">
        <p className="text-xs text-muted">{caption}</p>
        <p className="truncate text-lg font-bold leading-tight">{name}</p>
      </div>
    </div>
  )
}

/**
 * Vertical timeline. Each step is { label, note?, state: 'done' | 'current' | 'todo' | 'failed' } and the caller derives the
 * state from real application data (session status, the server's stage results, the receipt). Nothing is animated for show.
 */
export function Timeline({ steps, label = 'Payment timeline', tone = 'light' }) {
  return (
    <ol aria-label={label} className="flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1
        const dot =
          s.state === 'done' ? 'bg-success text-on-accent'
          : s.state === 'failed' ? 'bg-danger text-on-accent'
          : s.state === 'current' ? 'border-2 border-brand-700 bg-surface text-brand-700'
          : 'border-2 border-line-strong bg-surface text-subtle'
        return (
          <li key={s.label} aria-current={s.state === 'current' ? 'step' : undefined} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${dot}`}>
                {s.state === 'done' ? <Icon name="check" className="h-3.5 w-3.5" strokeWidth="3" />
                  : s.state === 'failed' ? <Icon name="x" className="h-3.5 w-3.5" strokeWidth="3" />
                  : s.state === 'current' ? <span className="h-2 w-2 rounded-full bg-brand-700" /> : null}
              </span>
              {!last && <span aria-hidden="true" className={`my-0.5 w-0.5 flex-1 ${s.state === 'done' ? 'bg-success' : 'bg-track'}`} />}
            </div>
            <div className={`pb-4 ${last ? 'pb-0' : ''}`}>
              <p className={`text-sm leading-6 ${s.state === 'todo' ? (tone === 'light' ? 'text-muted' : 'text-subtle') : 'font-semibold'}`}>
                {s.label}
                <span className="sr-only">{{ done: ' (done)', current: ' (in progress)', failed: ' (failed)', todo: ' (not yet)' }[s.state]}</span>
              </p>
              {s.note && <p className="text-xs text-muted">{s.note}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** One row of the transaction feed. The whole row is the link to the details. */
export function TransactionItem({ t, role, to }) {
  const other = role === 'merchant' ? t.payer_name : t.merchant_name
  const failed = t.status !== 'SUCCESS'
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-sunken active:bg-sunken">
        <Avatar name={other} size="h-10 w-10 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words font-semibold leading-snug">{other}</p>
          <p className="truncate text-xs text-muted">{t.order_reference ?? 'No order reference'} · {formatFeedTime(t.timestamp)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`amount font-bold ${failed ? 'text-muted' : ''}`}>{formatMoney(t.amount, t.currency)}</span>
          <StatusBadge status={t.status} />
        </div>
        <Icon name="chevron" className="hidden h-4 w-4 shrink-0 text-subtle sm:block" />
      </Link>
    </li>
  )
}

export function TransactionFeed({ rows, role, receiptPath, label = 'Transactions' }) {
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {rows.map((t) => <TransactionItem key={t.transaction_id} t={t} role={role} to={receiptPath(t.transaction_id)} />)}
    </ul>
  )
}

/**
 * A digital receipt. Everything shown comes from the server's transaction record. A SUCCESS FACE_PAY transaction can only
 * exist after the server accepted a face authentication including the basic liveness challenge (a single-use
 * authorization is the only way to confirm a payment), so the verification lines are facts about the record, not decoration.
 */
export function Receipt({ receipt, children }) {
  const ok = receipt.status === 'SUCCESS'
  const verified = ok && receipt.payment_method === 'FACE_PAY'
  return (
    <article aria-label="Payment receipt" className="print-card mx-auto w-full max-w-md animate-rise overflow-hidden rounded-2xl border border-line/80 bg-surface shadow-card">
      <div className={`px-6 pb-6 pt-5 text-center ${ok ? 'bg-success-soft' : 'bg-danger-soft'}`}>
        <Logo className="text-base" tile="h-7 w-7" />
        <span aria-hidden="true" className={`mx-auto mt-5 flex h-14 w-14 items-center justify-center rounded-full text-on-accent ${ok ? 'bg-success' : 'bg-danger'}`}>
          <Icon name={ok ? 'check' : 'x'} className="h-7 w-7" strokeWidth="2.6" />
        </span>
        <p className={`mt-3 text-sm font-bold ${ok ? 'text-success-ink' : 'text-danger-ink'}`}>{ok ? 'Payment successful' : `Payment ${receipt.status.toLowerCase()}`}</p>
        <Amount value={receipt.amount} currency={receipt.currency} className="mt-1 text-4xl sm:text-5xl" />
        <SimulatedTag className="mt-3" />
      </div>
      <div aria-hidden="true" className="relative h-0 border-t-2 border-dashed border-line">
        <span className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-canvas" />
        <span className="absolute -right-3 -top-3 h-6 w-6 rounded-full bg-canvas" />
      </div>
      <dl className="px-6 py-2">
        <Row label="To">
          {receipt.recipient_name ?? receipt.merchant_name}
          {receipt.recipient_masked_id && <span className="block font-mono text-xs font-normal text-muted">{receipt.recipient_masked_id}</span>}
        </Row>
        <Row label="From">
          {receipt.payer_name}
          {receipt.payer_masked_id && <span className="block font-mono text-xs font-normal text-muted">{receipt.payer_masked_id}</span>}
        </Row>
        {receipt.note && <Row label="Note">{receipt.note}</Row>}
        {receipt.order_reference && <Row label="Order">{receipt.order_reference}</Row>}
        {receipt.description && <Row label="Details">{receipt.description}</Row>}
        <Row label="Transaction ID"><span className="font-mono text-[0.8rem]">{receipt.transaction_id}</span></Row>
        <Row label="Date and time">{formatDateTime(receipt.timestamp)}</Row>
        {receipt.funding_source && (
          <Row label="Paid from">
            {receipt.funding_source.bank_name}
            <span className="block font-mono text-xs font-normal text-muted">{receipt.funding_source.account_ref}</span>
          </Row>
        )}
        {Number(receipt.fee ?? 0) > 0 && <Row label="Fee">{formatMoney(receipt.fee, receipt.currency)}</Row>}
        <Row label="Payment method">{receipt.payment_method === 'FACE_PAY' ? 'FacePay' : receipt.payment_method}</Row>
        {verified && <Row label="Authenticated">{receipt.authentication ?? 'Face + basic liveness check'}</Row>}
        <Row label="Payment status">{ok ? 'Successful' : receipt.status}</Row>
      </dl>
      <p className="px-6 pb-4 text-xs text-muted">{receipt.simulation_notice ?? SIMULATION_NOTICE}</p>
      {children && <div className="no-print flex flex-col gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-center">{children}</div>}
    </article>
  )
}

/** The one honest description of the protection, used wherever the customer is asked to trust the flow. */
export function SecurityNote({ className = '', transfer = false }) {
  return (
    <details className={`rounded-xl bg-surface/70 px-4 py-3 text-sm ring-1 ring-line ${className}`}>
      <summary className="cursor-pointer font-semibold">How this payment is protected</summary>
      <div className="mt-3 flex flex-col gap-2 text-fg">
        <p>Your face is recognised, then a basic movement-based liveness check runs. Only then is a short-lived authorization created for this exact payment: {transfer ? 'this person, this amount.' : 'this merchant, this amount, this order.'} It works once and expires in minutes.</p>
        <p>You then review the payment and confirm it yourself. Large or unusual payments can also ask for your payment PIN.</p>
        <p>FacePay is an academic prototype. The liveness check is basic and does not protect against deepfakes, replayed video, masks or other advanced attacks. Every payment is simulated and no real money moves.</p>
      </div>
    </details>
  )
}
