import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthDetails } from './AuthStages'
import CameraView from './CameraView'
import Icon from './Icon'
import ModelNotReady from './ModelNotReady'
import { Alert, Button, Spinner } from './ui'
import { useAuth } from '../hooks/useAuth'
import { useCamera } from '../hooks/useCamera'
import { useReadiness } from '../hooks/useReadiness'
import { trainModel } from '../services/faces'
import { isModelIssue, notReady } from '../utils/modelIssues'
import { positionHint } from '../utils/positionHint'
import { TIMING } from '../utils/authTiming'
import { classifyError, classifyRejection, failureMessage } from '../utils/authMessages'
import { liveStages } from '../utils/faceStages'
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
 *   assess(frameBase64) (optional)              -> the server's look at a preview frame; used only for framing advice
 *
 * Before the camera is offered it asks the server whether recognition can run at all (a trained model that includes this
 * customer). If it cannot, the reason and the one thing to do about it are shown, no frames are captured or sent, and
 * nothing is retried on a timer. A technical problem is never presented as a face that did not match.
 */
export default function FaceAuthFlow({ requestChallenge, verify, onOutcome, onError, Actions, assess, authorized = false }) {
  const { token } = useAuth()
  const readiness = useReadiness(token)
  const [training, setTraining] = useState(false)
  const [trainError, setTrainError] = useState(null)
  const [hint, setHint] = useState(null)
  const started = useRef(false) // one check at a time: a double tap cannot start two
  const camera = useCamera()
  const { videoRef, status: cameraStatus } = camera
  const [phase, setPhase] = useState('idle') // idle | challenge | baseline | turn | verifying | done | error
  const [instruction, setInstruction] = useState('')
  const [captured, setCaptured] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [errorCode, setErrorCode] = useState(null)
  const [problem, setProblem] = useState(null) // { category, title, message } for a failed request
  const run = useRef(0) // id of the active run; changing it cancels the capture loop
  const callbacks = useRef({})
  useEffect(() => {
    callbacks.current = { requestChallenge, verify, onOutcome, onError, assess }
  })

  useEffect(() => () => { run.current = -1 }, [])

  const begin = async () => {
    if (started.current || readiness.state?.ready !== true) return
    started.current = true
    const id = ++run.current
    const alive = () => run.current === id
    setResult(null)
    setError(null)
    setProblem(null)
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
      if (outcome?.result !== 'AUTHENTICATED' && isModelIssue(outcome?.reason)) {
        // The server could not run recognition: show why and what to do, not a "try again" that would send frames again.
        readiness.setState(notReady(outcome.reason, failureMessage(outcome)))
        setPhase('idle')
        callbacks.current.onOutcome?.(outcome)
        return
      }
      setResult(outcome)
      setPhase('done')
      callbacks.current.onOutcome?.(outcome)
    } catch (err) {
      if (!alive()) return
      if (isModelIssue(err?.code)) {
        readiness.setState(notReady(err.code, err.message))
        setPhase('idle')
        callbacks.current.onError?.(err)
        return
      }
      const found = err?.name === 'ApiError' ? classifyError(err) : { category: 'other', title: 'Face check stopped', message: err?.message || 'Something went wrong.' }
      setProblem(found)
      setError(found.message)
      setErrorCode(err?.code ?? null)
      setPhase('error')
      callbacks.current.onError?.(err)
    } finally {
      if (run.current === id) started.current = false
    }
  }

  const reset = () => {
    run.current++
    started.current = false
    setPhase('idle')
    setResult(null)
    setError(null)
  }

  const cameraOn = cameraStatus === 'active'
  const blocked = readiness.state && !readiness.state.ready ? readiness.state : null
  const canStart = cameraOn && readiness.state?.ready === true
  const train = async () => {
    setTraining(true)
    setTrainError(null)
    try {
      await trainModel(token)
      await readiness.recheck()
    } catch (err) {
      setTrainError(err?.message || 'Training did not complete. Try again.')
    } finally {
      setTraining(false)
    }
  }

  // Framing advice while the person lines up (never during a check, and only when the server can actually recognise them).
  useEffect(() => {
    if (phase !== 'idle' || !cameraOn || readiness.state?.ready !== true || !callbacks.current.assess) return undefined
    let stop = false
    let inFlight = false
    const tick = async () => {
      if (stop || inFlight) return
      inFlight = true
      try {
        const frame = captureFrame(videoRef.current, { maxSide: 480, quality: 0.6 })
        const looked = await callbacks.current.assess(frame)
        if (!stop) setHint(positionHint(looked))
      } catch {
        // advice only: a failed look just shows no advice
      } finally {
        inFlight = false
      }
    }
    tick()
    const timer = setInterval(tick, 1500)
    return () => { stop = true; clearInterval(timer) }
  }, [phase, cameraOn, readiness.state?.ready, videoRef])

  const busy = ['challenge', 'baseline', 'turn', 'verifying'].includes(phase)
  const authenticated = result?.result === 'AUTHENTICATED'
  const overlay = phase === 'baseline' ? 'Look at the camera and hold still' : phase === 'turn' ? instruction : phase === 'verifying' ? 'Analyzing your face…' : null
  const tone = phase === 'done' ? (authenticated ? 'ok' : 'bad') : 'neutral'
  const rejection = result && !authenticated ? classifyRejection(result) : null
  const stages = liveStages({
    cameraStatus, phase, result, authorized: authorized || (authenticated && Boolean(result?.authorization)),
    modelReady: readiness.state ? readiness.state.ready : null,
  })
  const firstName = String(result?.identity?.name ?? '').trim().split(/\s+/)[0]

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      {blocked && (
        <ModelNotReady readiness={blocked} onRecheck={readiness.recheck} onTrain={train} checking={readiness.checking} training={training} trainError={trainError} />
      )}

      {!blocked && (
        <CameraView camera={camera} busy={busy} overlay={overlay} scanning={['baseline', 'turn', 'verifying'].includes(phase)} tone={tone} guide={phase === 'idle'} guideTone={phase === 'idle' && hint ? (hint.tone === 'ok' ? 'ok' : 'warn') : null} />
      )}

      {!blocked && <section aria-label="Authentication" aria-live="polite" className="flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        {phase === 'idle' && (
          <>
            <div>
              <h2 className="text-xl font-extrabold">Position your face</h2>
              <p className="mt-1 text-sm text-slate-700">{cameraOn ? 'Hold the phone at eye level and keep your whole face inside the frame, then start. You will look at the camera and follow one short instruction.' : 'Turn the camera on, then keep your whole face inside the frame.'}</p>
              {cameraOn && hint && (
                <p role="status" aria-live="polite" data-testid="position-hint" className={`mt-2 text-sm font-semibold ${hint.tone === 'ok' ? 'text-emerald-800' : 'text-amber-900'}`}>{hint.message}</p>
              )}
            </div>
            {readiness.lookupError && !readiness.state && (
              <Alert tone="error">
                {readiness.lookupError}{' '}
                <button type="button" onClick={readiness.recheck} className="font-semibold underline">Check again</button>
              </Alert>
            )}
            {!readiness.state && !readiness.lookupError && <p role="status" className="text-sm text-slate-600">Checking that face recognition is ready…</p>}
            <Button size="lg" onClick={begin} disabled={!canStart}>Start face check</Button>
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
            <p className="mt-1 text-sm text-slate-700">Look straight at the camera and hold still. Keep your whole face inside the frame.</p>
            <LivenessDots step={1} />
          </div>
        )}

        {phase === 'turn' && (
          <div>
            <h2 className="text-xl font-extrabold">Quick security check</h2>
            <p className="mt-2 text-2xl font-extrabold text-brand-700">{instruction}</p>
            <p className="mt-1 text-sm text-slate-700">Basic liveness check. Turn gently, hold for a moment, and keep your whole face in the frame. A small turn is enough.</p>
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
                <h2 className="text-xl font-extrabold">{authenticated ? 'Identity verified' : rejection.title}</h2>
                <p role={authenticated ? undefined : 'alert'} className="mt-0.5 text-sm text-slate-700">{authenticated ? `Welcome back${firstName ? `, ${firstName}` : ''}` : rejection.message}</p>
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
            <h2 className="text-xl font-extrabold">{problem?.title ?? 'Face check stopped'}</h2>
            <Alert tone="error">{error}</Alert>
            {errorCode === 'BIOMETRIC_DISABLED' && <Link className="text-sm font-semibold text-brand-700 underline" to={SECURITY_PATH}>Open security settings</Link>}
            <Button size="lg" onClick={reset} variant={errorCode === 'BIOMETRIC_LOCKED' ? 'secondary' : 'primary'}>Try again</Button>
          </div>
        )}
      </section>}

      {(phase !== 'idle' || blocked) && <FaceStages rows={stages} />}
    </div>
  )
}

/** Every step of the check in order, each with its real state. State is shown in words and a symbol, never by colour alone. */
function FaceStages({ rows }) {
  const mark = { done: '✓', failed: '✕', current: '•', todo: '–' }
  const tone = { done: 'text-emerald-800 font-semibold', failed: 'text-rose-800 font-semibold', current: 'text-slate-900 font-semibold', todo: 'text-slate-600' }
  const chip = { done: 'bg-emerald-600 text-white', failed: 'bg-rose-600 text-white', current: 'bg-brand-700 text-white', todo: 'bg-slate-200 text-slate-600' }
  const word = { done: 'done', failed: 'failed', current: 'in progress', todo: 'not yet' }
  return (
    <ol aria-label="Face check steps" className="flex flex-col gap-2 rounded-[1.25rem] border border-slate-200/80 bg-white p-4 text-sm shadow-card">
      {rows.map((r) => (
        <li key={r.key} className={`flex items-center gap-2.5 ${tone[r.state]}`} aria-current={r.state === 'current' ? 'step' : undefined}>
          <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold ${chip[r.state]}`}>{mark[r.state]}</span>
          <span>{r.label}</span>
          <span className="sr-only">: {word[r.state]}</span>
        </li>
      ))}
    </ol>
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
