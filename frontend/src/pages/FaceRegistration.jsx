import { useCallback, useEffect, useState } from 'react'
import CameraView from '../components/CameraView'
import { StatusBadge } from '../components/payUi'
import { Alert, Button, Card, ConfirmPanel, ErrorState, PageHeader, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useCamera } from '../hooks/useCamera'
import { deleteSamples, getEnrollment, getModel, recognize, trainModel, uploadSample } from '../services/faces'
import { captureFrame } from '../utils/capture'
import { faceStatus } from '../utils/faceStatus'
import { pct } from '../utils/format'

const REASONS = {
  MATCH: 'Recognised as you.',
  WRONG_IDENTITY: 'The model thinks this is someone else.',
  TOO_FAR_FROM_PROFILE: 'It looks like you, but not close enough to your stored profile.',
}
const NAMES = { pca_knn: 'PCA + KNN', pca_lda_knn: 'PCA + LDA + KNN', pca_lda_svm: 'PCA + LDA + SVM' }

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

function ModelPanel({ model }) {
  return (
    <Card title="Trained model" aria-label="Model">
      <p className="text-sm text-slate-700">
        {model.includes_you && !model.stale
          ? 'The model includes your face and is up to date.'
          : model.includes_you
            ? 'The model includes an older version of your samples.'
            : 'You are not part of this model yet.'}
        {' '}It was trained on {model.n_users} {model.n_users === 1 ? 'person' : 'people'} and {model.n_samples} samples.
      </p>
      {model.stale && <div className="mt-3"><Alert tone="warning">Your samples changed since this model was trained. Retrain to include them.</Alert></div>}
      {!model.includes_you && <div className="mt-3"><Alert tone="warning">Train the model to add yourself.</Alert></div>}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-800">Technical details</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div><dt className="inline text-slate-600">Version: </dt><dd className="inline font-mono text-xs">{model.version}</dd></div>
          <div><dt className="inline text-slate-600">Deployed: </dt><dd className="inline">{NAMES[model.classifier]}</dd></div>
          <div><dt className="inline text-slate-600">PCA components: </dt><dd className="inline">{model.pca.n_components}</dd></div>
          <div><dt className="inline text-slate-600">LDA components: </dt><dd className="inline">{model.lda?.n_components ?? '—'}</dd></div>
          <div><dt className="inline text-slate-600">Validation: </dt><dd className="inline">{model.validation}</dd></div>
        </dl>
        <table className="mt-4 w-full text-left text-sm">
          <caption className="mb-1 text-left text-xs text-slate-600">
            Out-of-fold results on the enrolled users’ own samples (small data: treat as indicative, not a security guarantee).
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-slate-600">
              <th scope="col" className="py-1 pr-3 font-medium">Pipeline</th>
              <th scope="col" className="py-1 pr-3 font-medium">Accuracy</th>
              <th scope="col" className="py-1 font-medium">Macro F1</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(model.comparison).map(([key, m]) => (
              <tr key={key} className="border-b border-slate-100">
                <td className="py-1 pr-3">{NAMES[key] || key}</td>
                <td className="py-1 pr-3">{pct(m.accuracy)}</td>
                <td className="py-1">{pct(m.macro_f1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  )
}

const qualityNote = (q) =>
  q ? `Image quality looked good (face ${q.face_size}px wide${q.aligned ? ', well aligned' : ''}).` : ''

export default function FaceRegistration() {
  const { token } = useAuth()
  const camera = useCamera()
  const { videoRef, status: cameraStatus } = camera
  const [enrollment, setEnrollment] = useState(null)
  const [model, setModel] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState(null) // 'capture' | 'train' | 'recognize' | 'delete'
  const [notice, setNotice] = useState(null) // { tone, text }
  const [result, setResult] = useState(null)
  const [pose, setPose] = useState('neutral')
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

  const capture = () =>
    run('capture', async () => {
      const res = await uploadSample(token, { imageBase64: captureFrame(videoRef.current), pose })
      setEnrollment(res.enrollment)
      setNotice({ tone: 'success', text: `Sample saved. ${qualityNote(res.quality)}`.trim() })
    })

  const train = () =>
    run('train', async () => {
      const m = await trainModel(token)
      setModel(m)
      setResult(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Model trained. You are ready to pay with FacePay.' })
    })

  const test = () =>
    run('recognize', async () => {
      setResult(await recognize(token, captureFrame(videoRef.current)))
    })

  const remove = () => {
    setConfirmDelete(false)
    run('delete', async () => {
      await deleteSamples(token)
      setResult(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Your face data was deleted.' })
    })
  }

  const cameraOn = cameraStatus === 'active'
  const status = enrollment ? faceStatus(enrollment, model) : null
  const currentPose = enrollment?.poses.find((p) => p.pose === pose)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Face setup"
        subtitle="Capture varied samples, train the model, then test it. Images are reduced to a small grayscale crop on the server and stored encrypted; they are never shown back. This is an academic prototype."
        actions={status && <StatusBadge status={status.badge} label={status.label} />}
      />

      {loadError && <ErrorState message={loadError} onRetry={refresh} />}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card title="1. Camera">
        <CameraView camera={camera} busy={busy !== null} overlay={cameraOn && currentPose ? currentPose.instruction : null} />
      </Card>

      <Card title="2. Capture samples">
        {!enrollment ? (
          loadError ? null : <Spinner label="Loading enrollment" />
        ) : (
          <>
            <Progress value={enrollment.total_samples} max={enrollment.min_samples_to_train} label="Samples collected" />
            <p className="mt-2 text-sm text-slate-700">
              You need at least {enrollment.min_samples_to_train} samples across {enrollment.min_poses_to_train} different poses
              (you have {enrollment.total_samples} across {enrollment.distinct_poses}; up to {enrollment.max_samples} are kept).
            </p>
            <fieldset className="mt-4 flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Choose the pose you are about to capture</legend>
              {enrollment.poses.map((p) => (
                <label key={p.pose} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${pose === p.pose ? 'border-brand-700 bg-brand-50' : 'border-slate-200'}`}>
                  <input type="radio" name="pose" value={p.pose} checked={pose === p.pose} onChange={() => setPose(p.pose)} className="accent-brand-700" />
                  <span className="flex-1">{p.instruction}</span>
                  <span className="text-xs text-slate-700" data-testid={`count-${p.pose}`}>{p.count}/{p.target}</span>
                </label>
              ))}
            </fieldset>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={capture} loading={busy === 'capture'} disabled={!cameraOn || busy !== null}>
                Capture sample
              </Button>
              {!cameraOn && <span className="text-xs text-slate-600">Turn the camera on first.</span>}
            </div>
          </>
        )}
      </Card>

      <Card title="3. Train the model">
        <p className="text-sm text-slate-700">
          Trains one model on every enrolled user with enough samples. Recognition needs at least two enrolled users.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={train} loading={busy === 'train'} disabled={!enrollment?.eligible || busy !== null}>
            Train model
          </Button>
          <Button variant="secondary" onClick={() => setConfirmDelete(true)} disabled={!enrollment?.total_samples || busy !== null || confirmDelete}>
            Delete my face data
          </Button>
        </div>
        {enrollment && !enrollment.eligible && <p className="mt-2 text-xs text-slate-600">Capture more samples to enable training.</p>}
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

      {model && <ModelPanel model={model} />}

      <Card title="4. Test recognition">
        <p className="text-sm text-slate-700">Checks one new camera frame against the trained model.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={test} loading={busy === 'recognize'} disabled={!cameraOn || !model?.includes_you || busy !== null}>
            Recognise me
          </Button>
          {!model?.includes_you && <span className="text-xs text-slate-600">Train a model that includes you first.</span>}
        </div>
        {result && (
          <div className="mt-4" aria-live="polite">
            <Alert tone={result.matched ? 'success' : 'error'}>{REASONS[result.reason]}</Alert>
            <p className="mt-3 text-sm"><span className="text-slate-600">Match confidence: </span>{pct(result.confidence)}</p>
            <details className="mt-1 text-xs text-slate-700">
              <summary className="cursor-pointer font-medium">Technical details</summary>
              <p className="mt-2">Distance to your profile: {result.distance_to_you} (limit {result.distance_threshold}).</p>
              <p className="mt-1">The confidence score is the classifier’s vote share, not a calibrated probability.</p>
            </details>
          </div>
        )}
      </Card>
    </div>
  )
}
