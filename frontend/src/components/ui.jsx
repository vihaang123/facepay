import { Link } from 'react-router-dom'

export function Spinner({ label = 'Loading' }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-700" />
    </span>
  )
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label="Loading your session" />
    </div>
  )
}

/** FacePay wordmark. */
export function Logo({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 font-bold tracking-tight ${className}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6 text-brand-700" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
        <path d="M9 10v1M15 10v1M9.5 15c1.5 1.2 3.5 1.2 5 0" />
      </svg>
      FacePay
    </span>
  )
}

const TONES = {
  error: 'border-rose-200 bg-rose-50 text-rose-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-slate-200 bg-slate-50 text-slate-700',
}

export function Alert({ tone = 'info', children }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  )
}

export function FormField({ label, id, error, hint, ...inputProps }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        className={`rounded-lg border bg-white px-3 py-2 text-sm transition ${
          error ? 'border-rose-500' : 'border-slate-300 focus:border-brand-700'
        } disabled:bg-slate-100 disabled:text-slate-500`}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-rose-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-600">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed'
const BUTTON_STYLES = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-slate-300 disabled:text-slate-600',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-700 text-white hover:bg-rose-800 disabled:bg-slate-300 disabled:text-slate-600',
}

export function Button({ loading = false, disabled = false, variant = 'primary', children, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    >
      {loading && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  )
}

/** A link that looks like a Button. */
export function ButtonLink({ to, variant = 'primary', children, className = '', ...props }) {
  return (
    <Link to={to} className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${className}`} {...props}>
      {children}
    </Link>
  )
}

export function Card({ title, action, children, className = '', flush = false, as: Tag = 'section', ...props }) {
  return (
    <Tag className={`min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm ${flush ? 'overflow-hidden' : 'p-5'} ${className}`} {...props}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </Tag>
  )
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function StatTile({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
    </div>
  )
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center">
      <p className="font-medium text-slate-800">{title}</p>
      {children && <p className="max-w-sm text-sm text-slate-600">{children}</p>}
      {action}
    </div>
  )
}

/** A failed load with a way out. Never a blank space. */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Alert tone="error">{message}</Alert>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Wide tables scroll inside their card instead of breaking the page. */
export function TableWrap({ label, children }) {
  return (
    <div className="relative -mx-1 overflow-x-auto px-1">
      <table aria-label={label} className="w-full min-w-[28rem] text-left text-sm">
        {children}
      </table>
    </div>
  )
}

export const Th = ({ children, className = '' }) => (
  <th scope="col" className={`whitespace-nowrap border-b border-slate-200 py-2 pr-3 text-xs font-semibold uppercase tracking-wide text-slate-600 ${className}`}>
    {children}
  </th>
)

/**
 * Asks before something destructive happens, inside the page (no browser dialog).
 * Focus moves to the safe choice so an accidental Enter does not delete anything.
 */
export function ConfirmPanel({ title, children, confirmLabel, cancelLabel = 'Keep it', busy = false, onConfirm, onCancel }) {
  return (
    <div role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-body" className="rounded-xl border border-rose-200 bg-rose-50 p-4">
      <p id="confirm-title" className="font-semibold text-rose-900">{title}</p>
      <p id="confirm-body" className="mt-1 text-sm text-rose-900">{children}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>{cancelLabel}</Button>
        <Button variant="danger" onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
      </div>
    </div>
  )
}
