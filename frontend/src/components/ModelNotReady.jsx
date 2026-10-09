import { Link } from 'react-router-dom'
import Icon from './Icon'
import { Alert, Button } from './ui'
import { MODEL_ISSUES } from '../utils/modelIssues'
import { FACE_PATH } from '../utils/roles'

/**
 * Shown instead of the camera when recognition cannot run. It says which of the situations it is and offers the one
 * thing that can fix it. Nothing about the person's face has been judged, and it says so.
 */
export default function ModelNotReady({ readiness, onRecheck, onTrain, checking = false, training = false, trainError = null }) {
  const info = MODEL_ISSUES[readiness.code] ?? { next: readiness.next_action, title: 'Recognition model not ready' }
  const next = readiness.next_action ?? info.next
  return (
    <section aria-label="Recognition status" className="flex flex-col gap-4 rounded-[1.25rem] border border-amber-200 bg-white p-5 shadow-card">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Icon name="shield" className="h-6 w-6" /></span>
        <div>
          <h2 className="text-xl font-extrabold">{info.title}</h2>
          <p role="status" className="mt-1 text-sm text-slate-700">{readiness.message}</p>
          <p className="mt-1 text-sm text-slate-700">Nothing was decided about your face.</p>
        </div>
      </div>

      {next === 'WAIT_FOR_SECOND_PERSON' && (
        <p className="text-sm text-slate-700">Ask the other person to finish face setup on their own FacePay account (it takes about a minute), then check again. FacePay never creates a second person for you.</p>
      )}
      {next === 'CONTACT_ADMIN' && <p className="text-sm text-slate-700">This needs the person who runs this FacePay service. You can check again in a moment.</p>}
      {trainError && <Alert tone="error">{trainError}</Alert>}

      <div className="flex flex-col gap-2 sm:flex-row">
        {next === 'TRAIN' && onTrain && <Button size="lg" onClick={onTrain} loading={training} disabled={checking} className="sm:flex-1">Prepare recognition model</Button>}
        {next === 'ENROLL' && <Link to={FACE_PATH} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-5 text-base font-semibold text-white sm:flex-1">Finish face setup</Link>}
        <Button size="lg" variant="secondary" onClick={onRecheck} loading={checking} disabled={training} className="sm:flex-1">Check again</Button>
      </div>
    </section>
  )
}
