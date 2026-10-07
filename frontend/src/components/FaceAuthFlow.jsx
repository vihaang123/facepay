import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthDetails } from './AuthStages'
import CameraView from './CameraView'
import { Alert, Button, Card, Spinner } from './ui'
import { useCamera } from '../hooks/useCamera'
import { TIMING } from '../utils/authTiming'
import { errorMessage, failureMessage } from '../utils/authMessages'
import { captureFrame } from '../utils/capture'
import { FACE_PATH } from '../utils/roles'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Camera + challenge-response liveness + result panel, shared by the standalone authentication page and the
 * payment checkout. The caller supplies the two backend calls, so this component knows nothing about payments.
 *
 *   requestChallenge()                          -> { challenge_id, instruction, baseline_frames, max_frames, ... }
 *   verify({ challengeId, frames }, { signal }) -> the backend's decision (result, reason, stages, identity, ...)
 *   onOutcome(outcome) / onError(err)           -> called when an attempt ends
 *   Actions (component, optional)               -> replaces the default "Done" / "Try again" button; gets { result, authenticated, onRetry }
 */
export default function FaceAuthFlow({ requestChallenge, verify, onOutcome, onError, Actions }) {
  const camera = useCamera()
  const { videoRef, status: cameraStatus } = camera
  const [phase, setPhase] = useState('idle') // idle | challenge | baseline | turn | verifying | done | error
  const [instruction, setInstruction] = useState('')
  const [captured, setCaptured] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const run = useRef(0) // id of the active run; changing it cancels the capture loop
  const callbacks = useRef({})
  useEffect(() => {
    callbacks.current = { requestChallenge, verify, onOutcome, onError }
  })

  useEffect(() => () => { run.current = -1 }, [])

  const begin = async () => {
    const id = ++run.current
    const alive = () => run.current === id
    setResult(null)
    setError(null)
    setCaptured(0)
    setPhase('challenge')
    try {
      const challenge = await callbacks.current.requestChallenge()
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
        outcome = await callbacks.current.verify({ challengeId: challenge.challenge_id, frames }, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!alive()) return
      setResult(outcome)
      setPhase('done')
      callbacks.current.onOutcome?.(outcome)
    } catch (err) {
      if (!alive()) return
      setError(err instanceof Error && err.name === 'ApiError' ? errorMessage(err) : err.message || 'Something went wrong.')
      setPhase('error')
      callbacks.current.onError?.(err)
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
  const overlay = phase === 'baseline' ? 'Look at the camera and hold still' : phase === 'turn' ? instruction : phase === 'verifying' ? 'Verifying…' : null

  return (
    <>
      <Card title="Camera">
        <CameraView camera={camera} busy={busy} overlay={overlay} />
      </Card>

      <Card aria-label="Authentication" aria-live="polite">
        <Progress phase={phase} cameraOn={cameraOn} result={result} />

        {phase === 'idle' && (
          <div className="mt-4 flex flex-col items-start gap-3">
            <p className="text-sm text-slate-700">Ready when you are. You will look at the camera, then follow one short instruction such as turning your head.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={begin} disabled={!cameraOn}>Start authentication</Button>
              {!cameraOn && <span className="text-xs text-slate-600">Turn the camera on first.</span>}
            </div>
          </div>
        )}

        {phase === 'challenge' && <p className="mt-4 flex items-center gap-2 text-sm"><Spinner label="Preparing" /> Preparing your challenge…</p>}

        {phase === 'baseline' && (
          <div className="mt-4">
            <p className="text-lg font-semibold">Look at the camera</p>
            <p className="mt-1 text-sm text-slate-700">Hold still and face the camera.</p>
          </div>
        )}

        {phase === 'turn' && (
          <div className="mt-4">
            <p className="text-sm font-medium text-slate-600">Liveness check</p>
            <p className="mt-1 text-xl font-semibold">{instruction}</p>
            <p className="mt-2 text-xs text-slate-600">Frames captured: {captured}</p>
          </div>
        )}

        {phase === 'verifying' && <p className="mt-4 flex items-center gap-2 text-sm"><Spinner label="Verifying" /> Verifying identity…</p>}

        {phase === 'done' && result && (
          <div className="mt-4 flex flex-col gap-4">
            <Alert tone={authenticated ? 'success' : 'error'}>
              {authenticated ? 'Authentication successful' : failureMessage(result)}
            </Alert>
            <AuthDetails result={result} />
            {result.reason === 'NOT_ENROLLED' && (
              <Link className="text-sm font-semibold text-brand-700 underline" to={FACE_PATH}>Set up your face</Link>
            )}
            {Actions ? (
              <Actions result={result} authenticated={authenticated} onRetry={reset} />
            ) : (
              <div><Button onClick={reset} variant={authenticated ? 'secondary' : 'primary'}>{authenticated ? 'Done' : 'Try again'}</Button></div>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="mt-4 flex flex-col gap-3">
            <Alert tone="error">{error}</Alert>
            <div><Button onClick={reset}>Try again</Button></div>
          </div>
        )}
      </Card>
    </>
  )
}

const STEPS = ['Camera', 'Face detected', 'Liveness', 'Identity', 'Result']

/** Where the person is in the flow. Derived from real phase and the server's stage results. */
function Progress({ phase, cameraOn, result }) {
  const stage = (name) => result?.stages?.find((s) => s.stage === name)?.status
  const state = [
    cameraOn ? 'done' : phase === 'idle' ? 'current' : 'done',
    phase === 'challenge' || phase === 'baseline' ? 'current' : phase === 'idle' ? 'todo' : 'done',
    phase === 'turn' ? 'current' : ['idle', 'challenge', 'baseline'].includes(phase) ? 'todo' : stage('LIVENESS') === 'FAILED' ? 'failed' : 'done',
    phase === 'verifying' ? 'current' : ['done'].includes(phase) ? (stage('IDENTITY') === 'PASSED' ? 'done' : stage('IDENTITY') === 'FAILED' ? 'failed' : 'todo') : 'todo',
    phase === 'done' ? (result?.result === 'AUTHENTICATED' ? 'done' : 'failed') : 'todo',
  ]
  return (
    <ol aria-label="Progress" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={state[i] === 'current' ? 'step' : undefined}
          className={
            state[i] === 'failed' ? 'font-semibold text-rose-800'
            : state[i] === 'done' ? 'font-semibold text-emerald-800'
            : state[i] === 'current' ? 'font-semibold text-ink underline decoration-2 underline-offset-4'
            : 'text-slate-600'
          }
        >
          <span aria-hidden="true">{state[i] === 'done' ? '✓ ' : state[i] === 'failed' ? '✕ ' : `${i + 1}. `}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}
