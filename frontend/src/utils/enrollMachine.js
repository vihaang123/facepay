import { ENROLL_CONFIG } from './enrollConfig'

export const PHASE = {
  IDLE: 'IDLE',
  CAMERA_STARTING: 'CAMERA_STARTING',
  POSITION_FACE: 'POSITION_FACE',
  CHECKING_QUALITY: 'CHECKING_QUALITY',
  CAPTURING: 'CAPTURING',
  CAPTURE_SUCCESS: 'CAPTURE_SUCCESS',
  NEXT_POSE: 'NEXT_POSE',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
}

export const LIVE_PHASES = [PHASE.POSITION_FACE, PHASE.CHECKING_QUALITY]

export function initialState(guided) {
  return {
    phase: PHASE.IDLE,
    pose: guided?.next_pose ?? 'neutral',
    captured: guided?.captured ?? 0,
    required: guided?.required ?? 0,
    message: '',
    feedbackKey: null,
    stableSince: null,
    cooldownUntil: 0,
    poseSince: 0,
    nextPose: null,
    complete: false,
    error: null,
  }
}

/**
 * The guided-capture state machine. A pure reducer so every transition can be tested without a camera.
 * Timing comes from `config`; events carry the time (`now`) so nothing here reads the clock.
 */
export function enrollReducer(state, event, config = ENROLL_CONFIG) {
  const { phase } = state
  switch (event.type) {
    case 'SYNC': {
      // Server progress arrived (page load, reload). Never disturbs a run in progress.
      if (phase !== PHASE.IDLE && phase !== PHASE.ERROR) return state
      const g = event.guided
      return { ...state, pose: g?.next_pose ?? state.pose, captured: g?.captured ?? 0, required: g?.required ?? 0 }
    }
    case 'START':
      if (phase !== PHASE.IDLE && phase !== PHASE.ERROR) return state
      return { ...state, phase: PHASE.CAMERA_STARTING, error: null, message: '', feedbackKey: null, stableSince: null, complete: false }
    case 'CAMERA_READY':
      if (phase !== PHASE.CAMERA_STARTING) return state
      return { ...state, phase: PHASE.POSITION_FACE, poseSince: event.now, stableSince: null, message: '', feedbackKey: null }
    case 'CAMERA_FAILED':
    case 'FAIL':
      return { ...state, phase: PHASE.ERROR, error: event.message, stableSince: null }
    case 'CANCEL':
      return { ...state, phase: PHASE.IDLE, stableSince: null, message: '', feedbackKey: null, error: null }
    case 'FRAME': {
      if (phase !== PHASE.POSITION_FACE && phase !== PHASE.CHECKING_QUALITY) return state
      const { ok, key, message } = event.evaluation
      if (!ok) return { ...state, phase: PHASE.POSITION_FACE, stableSince: null, message, feedbackKey: key }
      const since = state.stableSince ?? event.now
      const stable = event.now - since >= config.stableMs
      if (stable && event.now >= state.cooldownUntil) {
        return { ...state, phase: PHASE.CAPTURING, stableSince: null, message: '', feedbackKey: null }
      }
      return { ...state, phase: PHASE.CHECKING_QUALITY, stableSince: since, message, feedbackKey: key }
    }
    case 'CAPTURE_OK': {
      if (phase !== PHASE.CAPTURING) return state
      const { progress, next_pose: nextPose } = event.result
      return {
        ...state,
        phase: PHASE.CAPTURE_SUCCESS,
        captured: progress.captured,
        required: progress.required,
        nextPose,
        complete: nextPose == null && progress.captured >= progress.required,
      }
    }
    case 'CAPTURE_REJECTED':
      if (phase !== PHASE.CAPTURING) return state
      return { ...state, phase: PHASE.POSITION_FACE, stableSince: null, cooldownUntil: event.now + config.cooldownMs, message: event.message, feedbackKey: 'REJECTED' }
    case 'FLASH_DONE': {
      if (phase !== PHASE.CAPTURE_SUCCESS) return state
      if (state.complete) return { ...state, phase: PHASE.COMPLETED }
      const changed = state.nextPose && state.nextPose !== state.pose
      return {
        ...state,
        phase: changed ? PHASE.NEXT_POSE : PHASE.POSITION_FACE,
        pose: state.nextPose ?? state.pose,
        poseSince: event.now,
        cooldownUntil: event.now + config.cooldownMs,
        stableSince: null,
        message: '',
        feedbackKey: null,
      }
    }
    case 'ADVANCE':
      if (phase !== PHASE.NEXT_POSE) return state
      return { ...state, phase: PHASE.POSITION_FACE, poseSince: event.now, stableSince: null }
    default:
      return state
  }
}
