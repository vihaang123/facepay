import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthDetails } from './AuthStages'
import CameraView from './CameraView'
import Icon from './Icon'
import { Alert, Button, Spinner } from './ui'
import { useCamera } from '../hooks/useCamera'
import { TIMING } from '../utils/authTiming'
import { errorMessage, failureMessage } from '../utils/authMessages'
import { captureFrame } from '../utils/capture'
import { FACE_PATH, SECURITY_PATH } from '../utils/roles'

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
  const [errorCode, setErrorCode] = useState(null)
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
    setErrorCode(null)
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
      setErrorCode(err?.code ?? null)
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
  const overlay = phase === 'baseline' ? 'Look at the camera and hold still' : phase === 'turn' ? instruction : phase === 'verifying' ? 'Analyzing your face…' : null
  const tone = phase === 'done' ? (authenticated ? 'ok' : 'bad') : 'neutral'
  const firstName = String(result?.identity?.name ?? '').trim().split(/\s+/)[0]

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <CameraView camera={camera} busy={busy} overlay={overlay} scanning={['baseline', 'turn', 'verifying'].includes(phase)} tone={tone} guide={phase === 'idle'} />

      <section aria-label="Authentication" aria-live="polite" className="flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        {phase === 'idle' && (
          <>
            <div>
              <h2 className="text-xl font-extrabold">Position your face</h2>
              <p className="mt-1 text-sm text-slate-700">{cameraOn ? 'Keep your face inside the frame, then start. You will look at the camera and follow one short instruction.' : 'Turn the camera on, then keep your face inside the frame.'}</p>
            </div>
            <Button size="lg" onClick={begin} disabled={!cameraOn}>Start face check</Button>
            {!cameraOn && <p className="-mt-2 text-xs text-slate-600">Turn the camera on first.</p>}
          </>
        )}

        {phase === 'challenge' && (
          <div>
            <h2 className="flex items-center gap-2 text-xl font-extrabold"><Spinner label="Preparing" /> Getting ready</h2>
            <p className="mt-1 text-sm text-slate-700">Preparing your security check…</p>
          </div>
        )}

        {phase === 'baseline' && (
          <div>
            <h2 className="text-xl font-extrabold">Hold still</h2>
            <p className="mt-1 text-sm text-slate-700">Capturing your face. Look at the camera.</p>
            <LivenessDots step={1} />
          </div>
        )}

        {phase === 'turn' && (
          <div>
            <h2 className="text-xl font-extrabold">Quick security check</h2>
            <p className="mt-2 text-2xl font-extrabold text-brand-700">{instruction}</p>
            <p className="mt-1 text-sm text-slate-700">Basic liveness check. Keep your face in the frame while you move.</p>
            <LivenessDots step={2} />
            <p className="mt-2 text-xs text-slate-600">Frames captured: {captured}</p>
          </div>
        )}

        {phase === 'verifying' && (
          <div>
            <h2 className="flex items-center gap-2 text-xl font-extrabold"><Spinner label="Verifying" /> Capturing complete</h2>
            <p className="mt-1 text-sm text-slate-700">Analyzing your face…</p>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${authenticated ? 'animate-pop bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                <Icon name={authenticated ? 'check' : 'x'} className="h-6 w-6" strokeWidth="2.4" />
              </span>
              <div>
                <h2 className="text-xl font-extrabold">{authenticated ? 'Identity verified' : 'We could not verify you'}</h2>
                <p role={authenticated ? undefined : 'alert'} className="mt-0.5 text-sm text-slate-700">{authenticated ? `Welcome back${firstName ? `, ${firstName}` : ''}` : failureMessage(result)}</p>
              </div>
            </div>
            <AuthDetails result={result} />
            {result.reason === 'NOT_ENROLLED' && (
              <Link className="text-sm font-semibold text-brand-700 underline" to={FACE_PATH}>Set up your face</Link>
            )}
            {Actions ? (
              <Actions result={result} authenticated={authenticated} onRetry={reset} />
            ) : (
              <Button size="lg" onClick={reset} variant={authenticated ? 'secondary' : 'primary'}>{authenticated ? 'Done' : 'Try again'}</Button>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-xl font-extrabold">Something went wrong</h2>
            <Alert tone="error">{error}</Alert>
            {errorCode === 'BIOMETRIC_DISABLED' && <Link className="text-sm font-semibold text-brand-700 underline" to={SECURITY_PATH}>Open security settings</Link>}
            <Button size="lg" onClick={reset} variant={errorCode === 'BIOMETRIC_LOCKED' ? 'secondary' : 'primary'}>Try again</Button>
          </div>
        )}
      </section>
    </div>
  )
}

/** Two dots for the two real capture stages of the liveness check: look straight, then turn. */
function LivenessDots({ step }) {
  return (
    <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-700" role="img" aria-label={`Step ${step} of 2`}>
      {[1, 2].map((n) => (
        <span key={n} aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${n < step ? 'bg-brand-700' : n === step ? 'bg-brand-700 ring-4 ring-brand-100' : 'bg-slate-300'}`} />
      ))}
      <span aria-hidden="true">{step === 1 ? 'Look straight' : 'Turn your head'}</span>
    </p>
  )
}
