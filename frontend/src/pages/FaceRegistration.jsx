import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useCamera } from '../hooks/useCamera'
import { deleteSamples, getEnrollment, getModel, recognize, trainModel, uploadSample } from '../services/faces'
import { captureFrame } from '../utils/capture'

const CAMERA_MESSAGES = {
  denied: 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.',
  unsupported: 'This browser cannot access a camera (it needs HTTPS or localhost).',
  error: 'The camera could not be started. Check that no other app is using it.',
}

const pct = (v) => `${(v * 100).toFixed(1)}%`

const REASONS = {
  MATCH: 'Recognised as you.',
  WRONG_IDENTITY: 'The model thinks this is someone else.',
  TOO_FAR_FROM_PROFILE: 'It looks like you, but not close enough to your stored profile.',
}

function ModelPanel({ model }) {
  const names = { pca_knn: 'PCA + KNN', pca_lda_knn: 'PCA + LDA + KNN', pca_lda_svm: 'PCA + LDA + SVM' }
  return (
    <section aria-label="Model" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold">Trained model</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-slate-500">Version: </dt><dd className="inline font-mono text-xs">{model.version}</dd></div>
        <div><dt className="inline text-slate-500">Deployed: </dt><dd className="inline">{names[model.classifier]}</dd></div>
        <div><dt className="inline text-slate-500">Users / samples: </dt><dd className="inline">{model.n_users} / {model.n_samples}</dd></div>
        <div><dt className="inline text-slate-500">PCA components: </dt><dd className="inline">{model.pca.n_components}</dd></div>
        <div><dt className="inline text-slate-500">LDA components: </dt><dd className="inline">{model.lda?.n_components ?? '—'}</dd></div>
        <div><dt className="inline text-slate-500">Validation: </dt><dd className="inline">{model.validation}</dd></div>
      </dl>
      <table className="mt-4 w-full text-left text-sm">
        <caption className="mb-1 text-left text-xs text-slate-500">
          Out-of-fold results on the enrolled users’ own samples (small data: treat as indicative, not a security guarantee).
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-1 pr-3 font-medium">Pipeline</th>
            <th className="py-1 pr-3 font-medium">Accuracy</th>
            <th className="py-1 font-medium">Macro F1</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(model.comparison).map(([key, m]) => (
            <tr key={key} className="border-b border-slate-100">
              <td className="py-1 pr-3">{names[key] || key}</td>
              <td className="py-1 pr-3">{pct(m.accuracy)}</td>
              <td className="py-1">{pct(m.macro_f1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {model.stale && <p className="mt-3 text-xs text-amber-700">Your samples changed since this model was trained. Retrain to include them.</p>}
      {!model.includes_you && <p className="mt-3 text-xs text-amber-700">You are not part of this model yet. Train to add yourself.</p>}
    </section>
  )
}

export default function FaceRegistration() {
  const { token } = useAuth()
  const { videoRef, status: cameraStatus, start: startCamera, stop: stopCamera } = useCamera()
  const [enrollment, setEnrollment] = useState(null)
  const [model, setModel] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState(null) // 'capture' | 'train' | 'recognize' | 'delete'
  const [notice, setNotice] = useState(null) // { tone, text }
  const [result, setResult] = useState(null)
  const [pose, setPose] = useState('neutral')

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
      setNotice({ tone: 'success', text: 'Sample saved.' })
    })

  const train = () =>
    run('train', async () => {
      const m = await trainModel(token)
      setModel(m)
      setResult(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Model trained.' })
    })

  const test = () =>
    run('recognize', async () => {
      setResult(await recognize(token, captureFrame(videoRef.current)))
    })

  const remove = () => {
    if (!window.confirm('Delete all your face samples and profile? Any model trained with them is retired.')) return
    run('delete', async () => {
      await deleteSamples(token)
      setResult(null)
      await refresh()
      setNotice({ tone: 'success', text: 'Your face data was deleted.' })
    })
  }

  const cameraOn = cameraStatus === 'active'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Face setup</h1>
        <p className="mt-1 text-sm text-slate-600">
          Capture varied samples, train the PCA → LDA → classifier model, then test recognition. Images are processed on the
          server into a small grayscale crop and stored encrypted; they are never shown back or sent anywhere else. This is an
          academic prototype.
        </p>
      </div>

      {loadError && <Alert tone="error">{loadError}</Alert>}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Camera</h2>
        <div className="mt-3 flex flex-col gap-3">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label="Camera preview"
            className={`aspect-[4/3] w-full max-w-md -scale-x-100 rounded-lg bg-slate-900 ${cameraOn ? '' : 'hidden'}`}
          />
          {CAMERA_MESSAGES[cameraStatus] && <Alert tone="error">{CAMERA_MESSAGES[cameraStatus]}</Alert>}
          <div className="flex gap-2">
            {cameraOn ? (
              <Button variant="secondary" onClick={stopCamera}>Turn camera off</Button>
            ) : (
              <Button onClick={startCamera} loading={cameraStatus === 'requesting'} disabled={cameraStatus === 'unsupported'}>
                Turn camera on
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">1. Capture samples</h2>
        {!enrollment ? (
          <div className="mt-3"><Spinner label="Loading enrollment" /></div>
        ) : (
          <>
            <p className="mt-1 text-sm text-slate-600">
              {enrollment.total_samples} samples across {enrollment.distinct_poses} poses. You need at least{' '}
              {enrollment.min_samples_to_train} samples across {enrollment.min_poses_to_train} different poses (up to{' '}
              {enrollment.max_samples}).
            </p>
            <fieldset className="mt-3 flex flex-col gap-2">
              <legend className="sr-only">Pose</legend>
              {enrollment.poses.map((p) => (
                <label key={p.pose} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <input type="radio" name="pose" value={p.pose} checked={pose === p.pose} onChange={() => setPose(p.pose)} />
                  <span className="flex-1">{p.instruction}</span>
                  <span className="text-xs text-slate-500" data-testid={`count-${p.pose}`}>{p.count}/{p.target}</span>
                </label>
              ))}
            </fieldset>
            <div className="mt-3">
              <Button onClick={capture} loading={busy === 'capture'} disabled={!cameraOn || busy !== null}>
                Capture sample
              </Button>
              {!cameraOn && <span className="ml-3 text-xs text-slate-500">Turn the camera on first.</span>}
            </div>
          </>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">2. Train</h2>
        <p className="mt-1 text-sm text-slate-600">
          Trains one model on every enrolled user with enough samples. LDA needs at least two users.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={train} loading={busy === 'train'} disabled={!enrollment?.eligible || busy !== null}>
            Train model
          </Button>
          <Button variant="secondary" onClick={remove} disabled={!enrollment?.total_samples || busy !== null}>
            Delete my face data
          </Button>
        </div>
        {enrollment && !enrollment.eligible && <p className="mt-2 text-xs text-slate-500">Capture more samples to enable training.</p>}
      </section>

      {model && <ModelPanel model={model} />}

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">3. Test recognition</h2>
        <p className="mt-1 text-sm text-slate-600">Sends one new frame through detection → PCA → LDA → classifier.</p>
        <div className="mt-3">
          <Button onClick={test} loading={busy === 'recognize'} disabled={!cameraOn || !model?.includes_you || busy !== null}>
            Recognise me
          </Button>
          {!model?.includes_you && <span className="ml-3 text-xs text-slate-500">Train a model that includes you first.</span>}
        </div>
        {result && (
          <div className="mt-4" aria-live="polite">
            <Alert tone={result.matched ? 'success' : 'error'}>{REASONS[result.reason]}</Alert>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt className="inline text-slate-500">Confidence score: </dt><dd className="inline">{pct(result.confidence)}</dd></div>
              <div>
                <dt className="inline text-slate-500">Distance to your profile: </dt>
                <dd className="inline">{result.distance_to_you} (limit {result.distance_threshold})</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              The confidence score is the classifier’s vote share, not a calibrated probability.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
