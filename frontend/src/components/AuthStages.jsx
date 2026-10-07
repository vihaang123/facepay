import { pct } from '../utils/format'

const STAGE_LABELS = {
  FACE_DETECTION: { PASSED: 'Face detected', FAILED: 'Face check failed', SKIPPED: 'Face detection' },
  LIVENESS: { PASSED: 'Liveness verified', FAILED: 'Liveness check failed', SKIPPED: 'Liveness check' },
  IDENTITY: { PASSED: 'Identity verified', FAILED: 'Identity not verified', SKIPPED: 'Identity verification' },
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
