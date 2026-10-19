import Icon from './Icon'
import { DEMO_DISCLAIMER } from '../utils/demo'

/** A bank's monogram on its accent colour. Deliberately not a logo: FacePay never uses a bank's real branding. */
export function BankMark({ bank, size = 'h-11 w-11 text-[0.7rem]' }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: bank?.color ?? '#334155' }}
      className={`flex shrink-0 items-center justify-center rounded-2xl font-extrabold tracking-tight text-white ${size}`}
    >
      {bank?.short ?? <Icon name="bank" className="h-5 w-5" />}
    </span>
  )
}

/** The one-line disclaimer that appears on every bank screen. */
export function DemoNotice({ className = '' }) {
  return (
    <p className={`flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-200 ${className}`}>
      <Icon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{DEMO_DISCLAIMER}</span>
    </p>
  )
}
