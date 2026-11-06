import { useState } from 'react'
import Icon from './Icon'

const MARK = {
  done: { icon: 'check', ring: 'bg-success text-on-accent', text: 'Done' },
  failed: { icon: 'x', ring: 'bg-danger text-on-accent', text: 'Failed' },
  skipped: { icon: null, ring: 'bg-track text-muted', text: 'Not reached' },
}

/** The step trail of a payment, exactly as the server computed it (nothing here is invented). Each step says its state in words
 *  for screen readers, so colour is never the only signal. */
export function Trail({ steps, className = '' }) {
  if (!steps?.length) return null
  return (
    <ol aria-label="Payment trail" className={`flex flex-col ${className}`}>
      {steps.map((s, i) => {
        const m = MARK[s.state] ?? MARK.skipped
        return (
          <li key={s.key} data-state={s.state} className="flex gap-3">
            <span className="flex flex-col items-center">
              <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${m.ring}`}>
                {m.icon ? <Icon name={m.icon} className="h-3.5 w-3.5" strokeWidth="2.8" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              {i < steps.length - 1 && <span aria-hidden="true" className="my-0.5 w-px flex-1 bg-line" />}
            </span>
            <p className={`pb-3 text-sm leading-6 ${s.state === 'failed' ? 'font-semibold text-danger-ink' : s.state === 'skipped' ? 'text-muted' : 'text-fg'}`}>
              {s.label}
              <span className="sr-only"> ({m.text})</span>
            </p>
          </li>
        )
      })}
    </ol>
  )
}

/** The 12-digit reference number, with a copy button (clipboard may be unavailable; then the number is still selectable). */
export function ReferenceNumber({ value, className = '' }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // no clipboard access: the number stays visible and selectable
    }
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="font-mono text-[0.8rem] tracking-wide" data-testid="utr">{value}</span>
      <button type="button" onClick={copy} aria-label="Copy reference number" className="no-print rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand-800 hover:bg-brand-50">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}
