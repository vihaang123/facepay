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
        <li key={s.stage} className={s.status === 'PASSED' ? 'text-emerald-700' : s.status === 'FAILED' ? 'text-rose-700' : 'text-slate-400'}>
          <span aria-hidden="true" className="mr-2 inline-block w-4 text-center font-bold">{STAGE_MARK[s.status]}</span>
          {STAGE_LABELS[s.stage][s.status]}
        </li>
      ))}
    </ol>
  )
}




/** Stage list plus the model's real numbers (confidence, distance). Shown for a decision, never invented. */
export function AuthDetails({ result }) {
  const authenticated = result.result === 'AUTHENTICATED'
  return (
    <>
      <Stages stages={result.stages} />
      {result.identity && (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {authenticated && result.identity.name && (
            <div className="sm:col-span-2"><dt className="inline text-slate-500">Verified as: </dt><dd className="inline font-semibold">{result.identity.name}</dd></div>
          )}
          <div><dt className="inline text-slate-500">Confidence: </dt><dd className="inline">{pct(result.identity.confidence)}</dd></div>
          <div>
            <dt className="inline text-slate-500">Distance to your profile: </dt>
            <dd className="inline">{result.identity.distance} (limit {result.identity.distance_threshold})</dd>
          </div>
        </dl>
      )}
      {result.identity && (
        <p className="text-xs text-slate-500">
          Confidence is the classifier’s score for your class (the lowest of {result.identity.frames_evaluated} frames), not a
          calibrated probability.
        </p>
      )}
    </>
  )
}
