import Icon from './Icon'
import { DEMO_DISCLAIMER } from '../utils/demo'

/** A bank's monogram on its accent colour. Deliberately not a logo: FacePay never uses a bank's real branding. */
export function BankMark({ bank, size = 'h-11 w-11 text-[0.7rem]' }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: bank?.color ?? '#334155' }}
      className={`flex shrink-0 items-center justify-center rounded-2xl font-bold tracking-tight text-white ${size}`}
    >
      {bank?.short ?? <Icon name="bank" className="h-5 w-5" />}
    </span>
  )
}

/** The one-line disclaimer that appears on every bank screen. */
export function DemoNotice({ className = '' }) {
  return (
    <p className={`flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-2.5 text-xs font-semibold text-warning-ink ring-1 ring-inset ring-warning-line ${className}`}>
      <Icon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{DEMO_DISCLAIMER}</span>
    </p>
  )
}

/**
 * The account details exactly as the server returned them. A field the provider did not return is not shown (no placeholder
 * and no guess). Nothing here is typed in by the person.
 */
export function AccountDetails({ account, className = '' }) {
  const rows = [
    ['Bank', account.bank_name],
    ['Account holder', account.holder_name],
    ['Account number', account.account_ref],
    ['Account type', account.account_type_label],
    ['IFSC', account.ifsc],
    ['Branch', account.branch],
  ].filter(([, value]) => value)
  return (
    <dl className={`divide-y divide-line rounded-2xl border border-line bg-surface ${className}`}>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-3">
          <dt className="shrink-0 text-sm text-muted">{label}</dt>
          <dd className={`min-w-0 break-words text-right text-sm font-semibold ${label === 'Account number' || label === 'IFSC' ? 'font-mono' : ''}`}>{value}</dd>
        </div>
      ))}
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <dt className="text-sm text-muted">Status</dt>
        <dd className="flex flex-wrap items-center justify-end gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold text-success-ink ring-1 ring-inset ring-success-line">
            <Icon name="check" className="h-3 w-3" strokeWidth="2.4" />{account.link_status_label ?? 'Linked'}
          </span>
          {account.is_default && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">Default</span>}
        </dd>
      </div>
    </dl>
  )
}
