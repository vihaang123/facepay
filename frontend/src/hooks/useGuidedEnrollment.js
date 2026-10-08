import { useCallback, useEffect, useReducer, useRef } from 'react'
import { ApiError } from '../services/api'
import { assessFrame, uploadSample } from '../services/faces'
import { captureFrame } from '../utils/capture'
import { ENROLL_CONFIG, FEEDBACK, SERVER_REJECTIONS } from '../utils/enrollConfig'
import { evaluateFrame } from '../utils/enrollGuidance'
import { enrollReducer, initialState, LIVE_PHASES, PHASE } from '../utils/enrollMachine'
import { measureFrame } from '../utils/frameMetrics'

const defaultEngine = {
  measure: measureFrame,
  grab: (video) => captureFrame(video, { quality: 0.7 }),
  assess: assessFrame,
  upload: uploadSample,
  capture: (video) => captureFrame(video),
  now: () => Date.now(),
}

/**
 * Drives guided, automatic face setup. The state machine decides what happens next; this hook only feeds it readings
 * (a live check about twice a second) and performs the two side effects: the capture upload and the timers.
 * `engine` and `config` exist so tests can run the whole flow without a camera or a clock.
 */
export function useGuidedEnrollment({ token, camera, guided, reducedMotion = false, onSample, onComplete, config = ENROLL_CONFIG, engine = defaultEngine }) {
  const [state, dispatch] = useReducer((s, e) => enrollReducer(s, e, config), guided, initialState)
  const live = useRef({ state, camera, token, reducedMotion })
  const cbs = useRef({})
  const scratch = useRef({ previous: null, baseline: null, noFace: 0, errors: 0 })
  useEffect(() => {
    live.current = { state, camera, token, reducedMotion }
    cbs.current = { onSample, onComplete }
  })

  // Server progress (first load, after a reload, after delete) re-seeds an idle machine.
  const guidedKey = guided ? `${guided.captured}/${guided.required}/${guided.next_pose}` : null
  useEffect(() => {
    if (guided) dispatch({ type: 'SYNC', guided })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedKey])

  // Camera permission and start-up.
  const cameraStatus = camera.status
  useEffect(() => {
    if (state.phase === PHASE.CAMERA_STARTING) {
      if (cameraStatus === 'active') dispatch({ type: 'CAMERA_READY', now: engine.now() })
      else if (['denied', 'unsupported', 'error'].includes(cameraStatus)) dispatch({ type: 'CAMERA_FAILED', message: 'camera' })
    } else if (cameraStatus !== 'active' && state.phase !== PHASE.IDLE && state.phase !== PHASE.ERROR && state.phase !== PHASE.COMPLETED) {
      dispatch({ type: 'FAIL', message: 'The camera stopped. Turn it back on to continue.' })
    }
  }, [state.phase, cameraStatus, engine])

  // Live quality checks while the person is positioning.
  const polling = LIVE_PHASES.includes(state.phase)
  useEffect(() => {
    if (!polling) return undefined
    let stopped = false
    let timer
    const ctl = new AbortController()
    scratch.current = { ...scratch.current, previous: null, errors: 0 }
    const tick = async () => {
      const { state: s, camera: cam, token: tk } = live.current
      const video = cam.videoRef.current
      try {
        const local = engine.measure(video, scratch.current.previous)
        scratch.current.previous = local.signature
        const image = engine.grab(video)
        const assess = await engine.assess(tk, image, { signal: ctl.signal })
        if (stopped) return
        scratch.current.errors = 0
        scratch.current.noFace = assess.face ? 0 : scratch.current.noFace + 1
        const now = engine.now()
        const evaluation = evaluateFrame({
          assess, local, pose: s.pose, baseline: scratch.current.baseline,
          relaxPose: now - s.poseSince > config.poseRelaxMs, noFaceStreak: scratch.current.noFace, config,
        })
        // The straight-ahead position is the reference every turn and tilt is measured from.
        if (evaluation.ok && s.pose === 'neutral') scratch.current.baseline = { cx: assess.face.cx, cy: assess.face.cy }
        dispatch({ type: 'FRAME', now, evaluation })
      } catch (err) {
        if (stopped) return
        scratch.current.errors += 1
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          dispatch({ type: 'FAIL', message: err.message })
          return
        }
        if (scratch.current.errors >= config.maxConsecutiveErrors) {
          dispatch({ type: 'FAIL', message: 'We could not reach FacePay. Check your connection and try again.' })
          return
        }
        const busy = err instanceof ApiError && err.status === 429
        dispatch({ type: 'FRAME', now: engine.now(), evaluation: { ok: false, key: busy ? 'BUSY' : 'OFFLINE', message: busy ? FEEDBACK.BUSY : FEEDBACK.OFFLINE } })
      }
      if (!stopped) timer = setTimeout(tick, config.pollIntervalMs)
    }
    timer = setTimeout(tick, 0)
    return () => {
      stopped = true
      ctl.abort()
      clearTimeout(timer)
    }
  }, [polling, config, engine])

  // The capture itself: one upload per entry into CAPTURING. The server decides whether to accept it.
  useEffect(() => {
    if (state.phase !== PHASE.CAPTURING) return undefined
    let stopped = false
    const { state: s, camera: cam, token: tk } = live.current
    ;(async () => {
      try {
        const result = await engine.upload(tk, { imageBase64: engine.capture(cam.videoRef.current), pose: s.pose })
        if (stopped) return
        cbs.current.onSample?.(result)
        dispatch({ type: 'CAPTURE_OK', result })
      } catch (err) {
        if (stopped) return
        const code = err instanceof ApiError ? err.code : null
        const message = (code && SERVER_REJECTIONS[code]) || (err instanceof ApiError && err.status === 429 ? SERVER_REJECTIONS.RATE_LIMITED : null)
        if (message || (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403)) {
          dispatch({ type: 'CAPTURE_REJECTED', now: engine.now(), message: message ?? err.message })
        } else {
          dispatch({ type: 'FAIL', message: err.message || 'Something went wrong while saving the sample.' })
        }
      }
    })()
    return () => { stopped = true }
  }, [state.phase, engine])

  // Short timed phases.
  useEffect(() => {
    if (state.phase === PHASE.CAPTURE_SUCCESS) {
      const ms = live.current.reducedMotion ? config.successFlashReducedMs : config.successFlashMs
      const t = setTimeout(() => dispatch({ type: 'FLASH_DONE', now: engine.now() }), ms)
      return () => clearTimeout(t)
    }
    if (state.phase === PHASE.NEXT_POSE) {
      const t = setTimeout(() => dispatch({ type: 'ADVANCE', now: engine.now() }), config.nextPoseMs)
      return () => clearTimeout(t)
    }
    return undefined
  }, [state.phase, config, engine])

  useEffect(() => {
    if (state.phase === PHASE.COMPLETED) cbs.current.onComplete?.()
  }, [state.phase])

  const { start: startCamera, stop: stopCamera } = camera
  const start = useCallback(() => {
    scratch.current = { previous: null, baseline: null, noFace: 0, errors: 0 }
    dispatch({ type: 'START' })
    startCamera()
  }, [startCamera])
  const cancel = useCallback(() => {
    dispatch({ type: 'CANCEL' })
    stopCamera()
  }, [stopCamera])

  return { state, start, cancel }
}
