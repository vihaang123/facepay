import { pct } from '../utils/format'
import { paymentStageList } from '../utils/paymentStages'

const STAGE_LABELS = {
  FACE_DETECTION: { PASSED: 'Face detected', FAILED: 'Face check failed', SKIPPED: 'Face detection' },
  LIVENESS: { PASSED: 'Basic liveness check passed', FAILED: 'Basic liveness check failed', SKIPPED: 'Basic liveness check' },
  IDENTITY: { PASSED: 'Identity recognized', FAILED: 'Identity not recognized', SKIPPED: 'Identity recognition' },
}
const STAGE_MARK = { PASSED: '✓', FAILED: '✕', SKIPPED: '–' }

export function Stages({ stages }) {
  return (
    <ol aria-label="Authentication stages" className="flex flex-col gap-1.5 text-sm">
      {stages.map((s) => (
        <li key={s.stage} className={s.status === 'PASSED' ? 'text-emerald-800' : s.status === 'FAILED' ? 'text-rose-800' : 'text-slate-600'}>
          <span aria-hidden="true" className="mr-2 inline-block w-4 text-center font-bold">{STAGE_MARK[s.status]}</span>
          {STAGE_LABELS[s.stage][s.status]}
        </li>
      ))}
    </ol>
  )
}

/**
 * What the person sees after a decision: the stage list, who they were verified as, and the match confidence.
 * Raw model numbers (distance to profile and its limit) are tucked behind "Technical details" for the curious.
 */
export function AuthDetails({ result }) {
  const authenticated = result.result === 'AUTHENTICATED'
  const id = result.identity
  return (
    <>
      <Stages stages={result.stages} />
      {id && (
        <dl className="text-sm">
          {authenticated && id.name && (
            <div><dt className="inline text-slate-600">Verified as: </dt><dd className="inline font-semibold">{id.name}</dd></div>
          )}
          <div><dt className="inline text-slate-600">Match confidence: </dt><dd className="inline">{pct(id.confidence)}</dd></div>
        </dl>
      )}
      {id && (
        <details className="text-xs text-slate-700">
          <summary className="cursor-pointer font-medium">Technical details</summary>
          <p className="mt-2">Distance to your profile: {id.distance} (limit {id.distance_threshold}).</p>
          <p className="mt-1">
            Confidence is the classifier’s score for your class (the lowest of {id.frames_evaluated} frames), not a calibrated
            probability. This is a classroom-scale model and not a guarantee of identity.
          </p>
        </details>
      )}
    </>
  )
}

const STATE_TEXT = { done: 'done', current: 'in progress', failed: 'failed', todo: 'not yet' }

export function PaymentStages({ outcome, authorized, confirming, paid, className = '' }) {
  const rows = paymentStageList({ outcome, authorized, confirming, paid })
  return (
    <ol aria-label="Payment stages" className={`flex flex-col gap-2 text-sm ${className}`}>
      {rows.map((r) => (
        <li key={r.label} className={`flex items-center gap-2.5 ${r.state === 'done' ? 'font-semibold text-emerald-800' : r.state === 'failed' ? 'font-semibold text-rose-800' : r.state === 'current' ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
          <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold ${r.state === 'done' ? 'bg-emerald-600 text-white' : r.state === 'failed' ? 'bg-rose-600 text-white' : r.state === 'current' ? 'bg-brand-700 text-white' : 'bg-slate-200 text-slate-600'}`}>
            {r.state === 'done' ? '✓' : r.state === 'failed' ? '✕' : r.state === 'current' ? '•' : '–'}
          </span>
          <span>{r.label}</span>
          <span className="sr-only">: {STATE_TEXT[r.state]}</span>
        </li>
      ))}
    </ol>
  )
}
