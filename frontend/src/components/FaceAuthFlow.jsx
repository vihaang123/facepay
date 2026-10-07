import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthDetails } from './AuthStages'
import { Alert, Button, Spinner } from './ui'
import { CAMERA_MESSAGES, useCamera } from '../hooks/useCamera'
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
  const { videoRef, status: cameraStatus, start: startCamera, stop: stopCamera } = useCamera()
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

  return (
    <>
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
            <AuthDetails result={result} />
            {result.reason === 'NOT_ENROLLED' && (
              <Link className="text-sm font-semibold text-brand-600" to={FACE_PATH}>Set up your face</Link>
            )}
            {Actions ? (
              <Actions result={result} authenticated={authenticated} onRetry={reset} />
            ) : (
              <div><Button onClick={reset} variant={authenticated ? 'secondary' : 'primary'}>{authenticated ? 'Done' : 'Try again'}</Button></div>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col gap-3">
            <Alert tone="error">{error}</Alert>
            <div><Button onClick={reset}>Try again</Button></div>
          </div>
        )}
      </section>

    </>
  )
}
