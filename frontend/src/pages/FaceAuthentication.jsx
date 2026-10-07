import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { CAMERA_MESSAGES, useCamera } from '../hooks/useCamera'
import { getAttempts, requestChallenge, verifyFace } from '../services/faceAuth'
import { TIMING } from '../utils/authTiming'
import { captureFrame } from '../utils/capture'
import { FACE_PATH } from '../utils/roles'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// What the user is told for each machine-readable rejection reason. Never names anyone else.
const REASON_MESSAGES = {
  FACE_NOT_DETECTED: 'We could not find your face. Face the camera in good light and try again.',
  MULTIPLE_FACES_DETECTED: 'More than one face is visible. For your security, only you may be in front of the camera.',
  FACE_TOO_SMALL: 'You are too far from the camera. Move closer and try again.',
  POOR_IMAGE_QUALITY: 'The picture was not clear enough (too dark, too bright or blurry). Improve the light and hold still.',
  INVALID_IMAGE: 'The camera image could not be read. Try again.',
  IDENTITY_MISMATCH: 'We could not verify that this is you.',
  LOW_CONFIDENCE: 'The match was not confident enough to verify you. Try again facing the camera in good light.',
  DISTANCE_TOO_HIGH: 'Your face was not close enough to your enrolled profile. Try again facing the camera in good light.',
  MODEL_UNAVAILABLE: 'Face recognition is not available right now. Please try again later.',
  NOT_ENROLLED: 'Your face is not part of the current model yet. Set up and train your face first.',
  ACCOUNT_DISABLED: 'This account is disabled.',
  CHALLENGE_EXPIRED: 'That took too long and the challenge expired. Start again.',
  CHALLENGE_INVALID: 'That challenge is no longer valid. Start again.',
}
const LIVENESS_MESSAGES = {
  NO_MOVEMENT: 'We did not see you turn your head.',
  INCOMPLETE_MOVEMENT: 'You started to turn but not far enough. Turn a little further.',
  WRONG_DIRECTION: 'You turned the wrong way. Follow the instruction on screen.',
  AMBIGUOUS_MOTION: 'Too much movement in both directions. Turn once, smoothly.',
  FACE_LOST: 'Your face left the camera view. Keep it in frame while you turn.',
  UNSTABLE_BASELINE: 'You were already moving at the start. Hold still first, then turn.',
  TOO_FEW_FRAMES: 'Not enough camera frames were captured. Try again.',
}

function failureMessage(result) {
  if (result.reason === 'LIVENESS_FAILED') {
    return `Liveness check failed. ${LIVENESS_MESSAGES[result.detail] ?? ''}`.trim()
  }
  return REASON_MESSAGES[result.reason] ?? 'Authentication was rejected.'
}

function errorMessage(err) {
  if (err.code === 'TIMEOUT') return 'The server took too long to respond. Please try again.'
  if (err.status === 0) return err.message
  if (err.status === 429) return 'Too many attempts. Please wait a minute and try again.'
  if (err.status === 403) return 'This account cannot use face authentication right now.'
  if (err.status >= 500) return 'Something went wrong on our side. Please try again.'
  return err.message
}

const STAGE_LABELS = {
  FACE_DETECTION: { PASSED: 'Face detected', FAILED: 'Face check failed', SKIPPED: 'Face detection' },
  LIVENESS: { PASSED: 'Liveness verified', FAILED: 'Liveness check failed', SKIPPED: 'Liveness check' },
  IDENTITY: { PASSED: 'Identity verified', FAILED: 'Identity not verified', SKIPPED: 'Identity verification' },
}
const STAGE_MARK = { PASSED: '✓', FAILED: '✕', SKIPPED: '–' }

function Stages({ stages }) {
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

const pct = (v) => `${(v * 100).toFixed(1)}%`

export default function FaceAuthentication() {
  const { token } = useAuth()
  const { videoRef, status: cameraStatus, start: startCamera, stop: stopCamera } = useCamera()
  const [phase, setPhase] = useState('idle') // idle | challenge | baseline | turn | verifying | done | error
  const [instruction, setInstruction] = useState('')
  const [captured, setCaptured] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [attempts, setAttempts] = useState([])
  const run = useRef(0) // id of the active run; changing it cancels the capture loop

  useEffect(() => () => { run.current = -1 }, [])

  const loadAttempts = useCallback(async () => {
    try {
      setAttempts(await getAttempts(token))
    } catch {
      setAttempts([])
    }
  }, [token])

  const begin = async () => {
    const id = ++run.current
    const alive = () => run.current === id
    setResult(null)
    setError(null)
    setCaptured(0)
    setPhase('challenge')
    try {
      const challenge = await requestChallenge(token)
      if (!alive()) return
      const frames = []
      const grab = () => {
        frames.push(captureFrame(videoRef.current, { quality: 0.8 }))
        setCaptured(frames.length)
      }

      setPhase('baseline')
      for (let i = 0; i < challenge.baseline_frames; i++) {
        if (i > 0) await sleep(TIMING.baselineGapMs)
        if (!alive()) return
        grab()
      }

      setInstruction(challenge.instruction)
      setPhase('turn')
      const turnFrames = Math.min(TIMING.turnFrames, challenge.max_frames - frames.length)
      for (let i = 0; i < turnFrames; i++) {
        await sleep(TIMING.turnGapMs)
        if (!alive()) return
        grab()
      }

      setPhase('verifying')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMING.requestTimeoutMs)
      let outcome
      try {
        outcome = await verifyFace(token, { challengeId: challenge.challenge_id, frames }, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!alive()) return
      setResult(outcome)
      setPhase('done')
      loadAttempts()
    } catch (err) {
      if (!alive()) return
      setError(err instanceof Error && err.name === 'ApiError' ? errorMessage(err) : err.message || 'Something went wrong.')
      setPhase('error')
    }
  }

  const reset = () => {
    run.current++
    setPhase('idle')
    setResult(null)
    setError(null)
  }

  const cameraOn = cameraStatus === 'active'
  const busy = ['challenge', 'baseline', 'turn', 'verifying'].includes(phase)
  const authenticated = result?.result === 'AUTHENTICATED'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">FacePay Authentication</h1>
        <p className="mt-1 text-sm text-slate-600">
          Look at the camera, then follow the on-screen instruction. Your face is checked for a live head movement and then
          verified by the PCA → LDA model. Academic prototype: not production-grade anti-spoofing.
        </p>
      </div>

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
              <Button variant="secondary" onClick={stopCamera} disabled={busy}>Turn camera off</Button>
            ) : (
              <Button onClick={startCamera} loading={cameraStatus === 'requesting'} disabled={cameraStatus === 'unsupported'}>
                Turn camera on
              </Button>
            )}
          </div>
        </div>
      </section>

      <section aria-label="Authentication" className="rounded-2xl border border-slate-200 bg-white p-5" aria-live="polite">
        {phase === 'idle' && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">Ready when you are. You will be asked to look at the camera and turn your head.</p>
            <div>
              <Button onClick={begin} disabled={!cameraOn}>Start authentication</Button>
              {!cameraOn && <span className="ml-3 text-xs text-slate-500">Turn the camera on first.</span>}
            </div>
          </div>
        )}

        {phase === 'challenge' && <p className="flex items-center gap-2 text-sm"><Spinner label="Preparing" /> Preparing your challenge…</p>}

        {phase === 'baseline' && (
          <div>
            <p className="text-lg font-semibold">Look at the camera</p>
            <p className="mt-1 text-sm text-slate-600">Hold still and face the camera.</p>
          </div>
        )}

        {phase === 'turn' && (
          <div>
            <p className="text-sm font-medium text-slate-500">Liveness check</p>
            <p className="mt-1 text-xl font-semibold">{instruction}</p>
            <p className="mt-2 text-xs text-slate-500">Frames captured: {captured}</p>
          </div>
        )}

        {phase === 'verifying' && <p className="flex items-center gap-2 text-sm"><Spinner label="Verifying" /> Verifying identity…</p>}

        {phase === 'done' && result && (
          <div className="flex flex-col gap-4">
            <Alert tone={authenticated ? 'success' : 'error'}>
              {authenticated ? 'Authentication successful' : failureMessage(result)}
            </Alert>
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
            {result.reason === 'NOT_ENROLLED' && (
              <Link className="text-sm font-semibold text-brand-600" to={FACE_PATH}>Set up your face</Link>
            )}
            <div><Button onClick={reset} variant={authenticated ? 'secondary' : 'primary'}>{authenticated ? 'Done' : 'Try again'}</Button></div>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col gap-3">
            <Alert tone="error">{error}</Alert>
            <div><Button onClick={reset}>Try again</Button></div>
          </div>
        )}
      </section>

      {attempts.length > 0 && (
        <section aria-label="Recent attempts" className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold">Recent attempts</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead><tr className="border-b border-slate-200 text-slate-500"><th className="py-1 pr-3 font-medium">When</th><th className="py-1 pr-3 font-medium">Result</th><th className="py-1 font-medium">Reason</th></tr></thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="py-1 pr-3">{new Date(a.timestamp).toLocaleString()}</td>
                  <td className="py-1 pr-3">{a.result === 'SUCCESS' ? 'Authenticated' : 'Rejected'}</td>
                  <td className="py-1">{a.failure_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
