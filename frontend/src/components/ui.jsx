import { Link } from 'react-router-dom'
import Icon from './Icon'

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

/** Grey placeholder block for content that is still loading. */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <span aria-hidden="true" className={`skeleton block rounded-lg ${className}`} />
}

/** Rows of placeholders shaped like a transaction feed; announced once as a status. */
export function FeedSkeleton({ label, rows = 3 }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3.5 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}

/** FacePay mark and wordmark: a scan frame around a face, on a teal tile. */
export function Logo({ className = '', tile = 'h-8 w-8' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-extrabold tracking-tight ${className}`}>
      <span aria-hidden="true" className={`flex ${tile} items-center justify-center rounded-[0.65rem] bg-brand-700 text-white`}>
        <Icon name="face" className="h-[62%] w-[62%]" strokeWidth="2" />
      </span>
      FacePay
    </span>
  )
}

const AVATAR_TONES = ['bg-brand-100 text-brand-800', 'bg-sky-100 text-sky-900', 'bg-violet-100 text-violet-900', 'bg-amber-100 text-amber-900', 'bg-rose-100 text-rose-900', 'bg-lime-100 text-lime-900']

/** Initials in a tinted circle. Chosen from the name, so one merchant always looks the same. There are no real logos. */
export function Avatar({ name = '?', size = 'h-11 w-11 text-sm' }) {
  const words = String(name).trim().split(/\s+/)
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
  const tone = AVATAR_TONES[[...String(name)].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length]
  return <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-full font-bold ${size} ${tone}`}>{initials}</span>
}

const TONES = {
  error: ['border-rose-200 bg-rose-50 text-rose-900', 'alert'],
  success: ['border-emerald-200 bg-emerald-50 text-emerald-900', 'check'],
  warning: ['border-amber-200 bg-amber-50 text-amber-900', 'alert'],
  info: ['border-slate-200 bg-white text-slate-700', 'shield'],
}

export function Alert({ tone = 'info', children, className = '' }) {
  const [classes, icon] = TONES[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-2.5 rounded-xl border px-4 py-3 text-sm ${classes} ${className}`}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const inputClass = (error) =>
  `min-h-12 w-full rounded-xl border bg-white px-3.5 text-base shadow-[inset_0_1px_0_rgb(11_27_51/0.02)] transition placeholder:text-slate-400 focus:border-brand-700 disabled:bg-slate-100 disabled:text-slate-500 ${
    error ? 'border-rose-500' : 'border-slate-300'
  }`

export function FormField({ label, id, error, hint, ...inputProps }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-slate-800">
        {label}
      </label>
      <input id={id} name={id} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} className={inputClass(error)} {...inputProps} />
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
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100'
const BUTTON_STYLES = {
  primary: 'bg-brand-700 text-white shadow-sm hover:bg-brand-800 disabled:bg-slate-300 disabled:text-slate-600 disabled:shadow-none',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-brand-800 hover:bg-brand-50 disabled:text-slate-400',
  dark: 'bg-ink text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:text-slate-600',
  danger: 'bg-rose-700 text-white hover:bg-rose-800 disabled:bg-slate-300 disabled:text-slate-600',
}
const SIZES = { md: '', lg: 'min-h-14 w-full text-base' }

export function Button({ loading = false, disabled = false, variant = 'primary', size = 'md', children, className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
      className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {loading && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  )
}

/** A link that looks like a Button. */
export function ButtonLink({ to, variant = 'primary', size = 'md', children, className = '', ...props }) {
  return (
    <Link to={to} className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${SIZES[size]} ${className}`} {...props}>
      {children}
    </Link>
  )
}

export function Card({ title, action, children, className = '', flush = false, as: Tag = 'section', ...props }) {
  return (
    <Tag className={`min-w-0 rounded-[1.25rem] border border-slate-200/80 bg-white shadow-card ${flush ? 'overflow-hidden' : 'p-5'} ${className}`} {...props}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-bold">{title}</h2>}
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
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-prose text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function StatTile({ label, value, hint, icon }) {
  return (
    <div className="rounded-[1.25rem] border border-slate-200/80 bg-white p-4 shadow-card">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">{icon && <Icon name={icon} className="h-4 w-4" />}{label}</p>
      <p className="amount mt-1.5 text-2xl font-extrabold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
    </div>
  )
}

export function EmptyState({ title, children, action, icon = 'receipt' }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-9 text-center">
      <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="mt-1 font-bold text-slate-900">{title}</p>
      {children && <p className="max-w-xs text-sm text-slate-600">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** A failed load with a way out. Never a blank space. */
export function ErrorState({ message, onRetry, title = 'Something went wrong' }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-xl bg-rose-50/60 px-4 py-8 text-center">
      <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-100 text-rose-700"><Icon name="alert" className="h-6 w-6" /></span>
      <p className="mt-1 font-bold text-slate-900">{title}</p>
      <p className="max-w-xs text-sm text-slate-700">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry} className="mt-2">Try again</Button>}
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
  <th scope="col" className={`whitespace-nowrap border-b border-slate-200 py-2 pr-3 text-xs font-semibold text-slate-600 ${className}`}>
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
      <p id="confirm-title" className="font-bold text-rose-900">{title}</p>
      <p id="confirm-body" className="mt-1 text-sm text-rose-900">{children}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>{cancelLabel}</Button>
        <Button variant="danger" onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
      </div>
    </div>
  )
}
