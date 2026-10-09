import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icon'
import { useGuidedEnrollment } from '../hooks/useGuidedEnrollment'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { POSE_COPY } from '../utils/enrollConfig'
import { LIVE_PHASES, PHASE } from '../utils/enrollMachine'
import CameraView from '../components/CameraView'
import { StatusBadge } from '../components/payUi'
import { Alert, Button, Card, ConfirmPanel, ErrorState, PageHeader, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { CAMERA_MESSAGES, useCamera } from '../hooks/useCamera'
import { deleteSamples, getEnrollment, getModel, getReadiness, recognize, trainModel } from '../services/faces'
import { captureFrame } from '../utils/capture'
import { faceStatus } from '../utils/faceStatus'

const REASONS = {
  MATCH: 'Recognised as you.',
  WRONG_IDENTITY: 'The model thinks this is someone else.',
  TOO_FAR_FROM_PROFILE: 'It looks like you, but not close enough to your stored profile.',
}

/** A progress bar that is also a proper meter for screen readers. */
function Progress({ value, max, label }) {
  const pctDone = Math.min(100, Math.round((value / Math.max(1, max)) * 100))
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-slate-700">{value} of {max}</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-brand-700 transition-all" style={{ width: `${pctDone}%` }} />
      </div>
    </div>
  )
}

/** What a customer needs to know about the model: whether it is ready and includes them. Settings and scores are admin-only. */
/** Whether a face check can run right now, and if not, exactly why. Wording comes from the server. */
function ReadinessPanel({ readiness }) {
  const c = readiness.checks
  return (
    <Card title="Recognition status" aria-label="Recognition status">
      {readiness.ready
        ? <Alert tone="success">Face recognition is ready for your account.</Alert>
        : <Alert tone="warning">{readiness.message}</Alert>}
      {c && (
        <ul className="mt-3 flex flex-col gap-1 text-sm text-slate-700">
          <li>Usable samples: {c.samples.have} of {c.samples.need} needed</li>
          <li>Head positions covered: {c.poses.have} of {c.poses.need} needed</li>
          <li>{c.people_with_finished_setup.enough ? 'At least two people have a finished setup.' : 'Recognition needs at least two people with a finished setup. FacePay never creates a second person for you.'}</li>
          <li>{c.model_active ? (c.you_are_in_model ? 'You are part of the trained model.' : 'The trained model does not include you yet.') : 'No trained model yet.'}</li>
        </ul>
      )}
    </Card>
  )
}

function ModelPanel({ model }) {
  return (
    <Card title="Face model" aria-label="Model">
      <p className="text-sm text-slate-700">
        {model.includes_you && !model.stale
          ? 'Your face is part of the current model and it is up to date.'
          : model.includes_you
            ? 'The model includes an older version of your samples.'
            : 'You are not part of this model yet.'}
      </p>
      {model.stale && <div className="mt-3"><Alert tone="warning">Your samples changed since this model was trained. Retrain to include them.</Alert></div>}
      {!model.includes_you && <div className="mt-3"><Alert tone="warning">Train the model to add yourself.</Alert></div>}
      <p className="mt-3 text-xs text-slate-600">Trained {new Date(model.trained_at).toLocaleDateString()}.</p>
    </Card>
  )
}


const poseCopy = (pose, fallback) => POSE_COPY[pose] ?? { label: fallback ?? pose, title: fallback ?? 'Hold still', hint: '', retry: fallback ?? '' }

/** The five head positions as a row of steps. Each shows its state in words and an icon, never by colour alone. */
function PoseSteps({ sequence, currentPose, running }) {
  return (
    <ol aria-label="Head positions" className="flex items-start justify-between gap-1">
      {sequence.map((p) => {
        const done = p.count >= p.target
        const current = running && p.pose === currentPose && !done
        return (
          <li key={p.pose} aria-current={current ? 'step' : undefined} className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center">
            <span
              aria-hidden="true"
              className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-emerald-600 text-white' : current ? 'bg-brand-700 text-white ring-4 ring-brand-100' : 'bg-slate-200 text-slate-700'}`}
            >
              {done ? <Icon name="check" className="h-4 w-4" strokeWidth="3" /> : p.count}
            </span>
            <span className={`text-xs ${current ? 'font-bold text-slate-900' : 'text-slate-700'}`}>{poseCopy(p.pose).label}</span>
            <span className="sr-only">{done ? 'done' : current ? 'current' : `${p.count} of ${p.target} captured`}</span>
          </li>
        )
      })}
    </ol>
  )
}

function headlineFor(state, ctx) {
  const { phase, pose } = state
  const copy = poseCopy(pose)
  switch (phase) {
    case PHASE.IDLE:
      if (ctx.complete) return { title: 'Face setup complete', text: ctx.trained ? 'Your face is set up. You can pay with FacePay.' : 'All five positions are captured. Finish setup to start paying with your face.' }
      return {
        title: ctx.captured > 0 ? 'Continue your face setup' : 'Set up FacePay with your face',
        text: 'FacePay will guide you through five head positions and capture each one automatically. It takes about a minute.',
      }
    case PHASE.CAMERA_STARTING: return { title: 'Starting your camera', text: 'Allow camera access if your browser asks.' }
    case PHASE.POSITION_FACE:
    case PHASE.CHECKING_QUALITY: return { title: copy.title, text: state.message || copy.hint }
    case PHASE.CAPTURING: return { title: 'Capturing', text: 'Hold still for a moment.' }
    case PHASE.CAPTURE_SUCCESS: return { title: 'Captured', text: state.complete ? 'That was the last one.' : 'Nice. Keep going.' }
    case PHASE.NEXT_POSE: return { title: `Next: ${poseCopy(state.nextPose).title.toLowerCase()}`, text: 'Get ready.' }
    case PHASE.COMPLETED: return { title: 'Face setup complete', text: ctx.finishing ? 'Preparing your face profile…' : ctx.trained ? 'Your face profile is ready.' : 'Finish setup to start paying with your face.' }
    default: return { title: 'Face setup stopped', text: state.error === 'camera' ? CAMERA_MESSAGES[ctx.cameraStatus] ?? CAMERA_MESSAGES.error : state.error }
  }
}

function GuidedSetup({ camera, enrollment, model, token, reducedMotion, onSample, finishing, finishError, onFinish }) {
  const guided = enrollment.guided
  const flow = useGuidedEnrollment({ token, camera, guided, reducedMotion, onSample, onComplete: onFinish })
  const { state, start, cancel } = flow
  const running = [PHASE.CAMERA_STARTING, ...LIVE_PHASES, PHASE.CAPTURING, PHASE.CAPTURE_SUCCESS, PHASE.NEXT_POSE].includes(state.phase)
  const trained = Boolean(model?.includes_you && !model.stale)
  const complete = guided.complete || state.phase === PHASE.COMPLETED
  const head = headlineFor(state, { complete, trained, captured: guided.captured, finishing, cameraStatus: camera.status })
  const warn = state.phase === PHASE.POSITION_FACE && state.message
  const guideTone = state.phase === PHASE.CHECKING_QUALITY || state.phase === PHASE.CAPTURING ? 'ok' : warn ? 'warn' : null
  const tone = state.phase === PHASE.CAPTURE_SUCCESS || state.phase === PHASE.COMPLETED ? 'ok' : 'neutral'
  const current = guided.sequence.find((p) => p.pose === state.pose)
  const overlay = running && [...LIVE_PHASES, PHASE.CAPTURING].includes(state.phase) ? (state.message || poseCopy(state.pose).title) : null

  return (
    <Card title="Set up your face" aria-label="Guided face setup">
      <div data-testid="enroll-stage" data-phase={state.phase} data-motion={reducedMotion ? 'reduced' : 'full'}>
        <CameraView
          camera={camera}
          controls={false}
          busy={running}
          overlay={overlay}
          tone={tone}
          guideTone={guideTone}
          flash={state.phase === PHASE.CAPTURE_SUCCESS}
          guide={running}
          footnote="Frames are checked on the server and are not kept. When a position is captured, only a small grayscale crop is stored, encrypted."
        />
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2 className="text-xl font-extrabold">{head.title}</h2>
          {head.text && <p className={`mt-1 text-sm ${warn ? 'font-semibold text-amber-800' : 'text-slate-700'}`}>{head.text}</p>}
        </div>

        <PoseSteps sequence={guided.sequence} currentPose={state.pose} running={running} />
        <Progress value={guided.captured} max={guided.required} label="Setup progress" />
        {running && current && (
          <p className="text-xs text-slate-700" data-testid="pose-samples">
            {poseCopy(current.pose).label}: {current.count} of {current.target} captured
          </p>
        )}

        {finishError && <Alert tone="error">{finishError}</Alert>}

        <div className="flex flex-col gap-2 sm:flex-row">
          {state.phase === PHASE.IDLE && !complete && <Button size="lg" onClick={start} className="sm:flex-1">{guided.captured > 0 ? 'Continue face setup' : 'Start face setup'}</Button>}
          {state.phase === PHASE.IDLE && complete && !trained && <Button size="lg" onClick={onFinish} loading={finishing} className="sm:flex-1">Finish setup</Button>}
          {state.phase === PHASE.ERROR && <Button size="lg" onClick={start} className="sm:flex-1">Try again</Button>}
          {state.phase === PHASE.COMPLETED && !trained && !finishing && <Button size="lg" onClick={onFinish} className="sm:flex-1">Finish setup</Button>}
          {running && <Button variant="secondary" onClick={cancel} className="sm:flex-1">Cancel setup</Button>}
        </div>
      </div>
      
    </Card>
  )
}

function HowItWorks() {
  return (
    <Card title="How FacePay works">
      <details className="text-sm text-slate-700">
        <summary className="cursor-pointer font-medium text-slate-800">Read how your face is used</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p>Each captured position is reduced on the server to a small grayscale crop and stored encrypted. Raw camera frames are not kept.</p>
          <p>The crops are projected with PCA, which keeps the main ways faces differ, then LDA, which pulls different people further apart. A classifier compares a new face with enrolled profiles.</p>
          <p>Recognising your face is only one part of paying. Each payment also needs a basic movement-based liveness check, a short-lived authorization tied to that payment, and your own confirmation. Large or unusual payments can ask for a payment PIN too.</p>
          <p>This is an academic prototype. The liveness check is basic and does not protect against deepfakes, replayed video, masks or other advanced attacks. All payments are simulated.</p>
        </div>
      </details>
    </Card>
  )
}

export default function FaceRegistration() {
  const { token } = useAuth()
  const camera = useCamera()
  const { videoRef, status: cameraStatus } = camera
  const reducedMotion = usePrefersReducedMotion()
  const [enrollment, setEnrollment] = useState(null)
  const [model, setModel] = useState(null)
  const [readiness, setReadiness] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState(null) // 'train' | 'recognize' | 'delete'
  const [notice, setNotice] = useState(null) // { tone, text }
  const [finishError, setFinishError] = useState(null)
  const [result, setResult] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [e, m] = await Promise.all([getEnrollment(token), getModel(token)])
      setEnrollment(e)
      setModel(m.model)
      setLoadError(null)
    } catch (err) {
      setLoadError(err.message)
    }
    try {
      setReadiness(await getReadiness(token))
    } catch {
      setReadiness(null) // the status line is advice; the page works without it
    }
  }, [token])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  const run = async (kind, fn) => {
    setBusy(kind)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice({ tone: 'error', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  // Setup is complete: release the camera and prepare the shared model. A failure leaves a retry button.
  const finish = useCallback(async () => {
    camera.stop()
    setBusy('train')
    setFinishError(null)
    try {
      setModel(await trainModel(token))
      setResult(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Your face profile is ready. You can pay with FacePay.' })
    } catch (err) {
      setFinishError(err.message)
      await refresh()
    } finally {
      setBusy(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refresh, camera.stop])

  const test = () =>
    run('recognize', async () => {
      setResult(await recognize(token, captureFrame(videoRef.current)))
    })

  const remove = () => {
    setConfirmDelete(false)
    run('delete', async () => {
      await deleteSamples(token)
      setResult(null)
      setFinishError(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Your face data was deleted. Face payments are off until you set up your face again.' })
    })
  }

  const cameraOn = cameraStatus === 'active'
  const status = enrollment ? faceStatus(enrollment, model) : null

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Face setup"
        subtitle="FacePay guides you through five head positions and captures each one for you. This is an academic prototype and payments are simulated."
        actions={status && <StatusBadge status={status.badge} label={status.label} />}
      />

      {loadError && <ErrorState message={loadError} onRetry={refresh} />}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {!enrollment ? (
        loadError ? null : <Spinner label="Loading enrollment" />
      ) : (
        <GuidedSetup
          camera={camera}
          enrollment={enrollment}
          model={model}
          token={token}
          reducedMotion={reducedMotion}
          onSample={(res) => setEnrollment(res.enrollment)}
          finishing={busy === 'train'}
          finishError={finishError}
          onFinish={finish}
        />
      )}

      <Card title="Your face data">
        <p className="text-sm text-slate-700">
          {enrollment?.total_samples
            ? `${enrollment.total_samples} ${enrollment.total_samples === 1 ? 'position is' : 'positions are'} stored as small encrypted grayscale crops. You can remove them at any time.`
            : 'No face data is stored for you.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setConfirmDelete(true)} disabled={!enrollment?.total_samples || busy !== null || confirmDelete}>
            Delete my face data
          </Button>
        </div>
        {confirmDelete && (
          <div className="mt-4">
            <ConfirmPanel
              title="Delete all your face data?"
              confirmLabel="Delete face data"
              busy={busy === 'delete'}
              onConfirm={remove}
              onCancel={() => setConfirmDelete(false)}
            >
              This removes every sample and your stored profile. Any model trained with them is retired, and you will not be able to pay with FacePay until you set up your face again. This cannot be undone.
            </ConfirmPanel>
          </div>
        )}
      </Card>

      {readiness && <ReadinessPanel readiness={readiness} />}
      {model && <ModelPanel model={model} />}

      <HowItWorks />

      <Card title="Test recognition">
        <p className="text-sm text-slate-700">Checks one new camera frame against the trained model. This is a practice check and does not pay or log you in.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={cameraOn ? test : camera.start} loading={busy === 'recognize' || cameraStatus === 'requesting'} disabled={!model?.includes_you || busy !== null}>
            {cameraOn ? 'Recognise me' : 'Turn camera on to test'}
          </Button>
          {!model?.includes_you && <span className="text-xs text-slate-600">Finish face setup first.</span>}
        </div>
        {result && (
          <div className="mt-4" aria-live="polite">
            <Alert tone={result.matched ? 'success' : 'error'}>{REASONS[result.reason]}</Alert>
          </div>
        )}
      </Card>
    </div>
  )
}
