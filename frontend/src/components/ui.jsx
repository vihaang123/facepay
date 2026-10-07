export function Spinner({ label = 'Loading' }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
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

const TONES = {
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
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
        className={`rounded-lg border bg-white px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-brand-500/40 ${
          error ? 'border-rose-400' : 'border-slate-300 focus:border-brand-500'
        } disabled:bg-slate-100 disabled:text-slate-500`}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Button({ loading = false, variant = 'primary', children, className = '', ...props }) {
  const styles =
    variant === 'primary'
      ? 'bg-brand-600 text-white hover:bg-brand-500 disabled:bg-brand-600/60'
      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400'
  return (
    <button
      disabled={loading || props.disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {children}
    </button>
  )
}
