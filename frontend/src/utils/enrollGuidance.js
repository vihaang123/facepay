import { ENROLL_CONFIG, FEEDBACK, POSE_COPY } from './enrollConfig'

/**
 * Turns one live reading into a verdict: { ok, key, message }.
 *
 *   assess  - the server's stateless look at the frame: { state, faces, face: {cx, cy, width, height} | null }
 *   local   - cheap canvas readings: { brightness, sharpness, motion }
 *   pose    - the pose being captured
 *   baseline- where the face sat when looking straight ({cx, cy}), or null
 *   relaxPose - true once the head-position check has timed out
 *
 * The head-position check is a rough guess from how the face box moved. It cannot prove which way a head is turned,
 * which is why it relaxes after a while and why the server never relies on it.
 */
export function evaluateFrame({ assess, local, pose, baseline, relaxPose = false, noFaceStreak = 0, config = ENROLL_CONFIG }) {
  const bad = (key, message) => ({ ok: false, key, message })
  const { state, faces, face } = assess

  if (faces > 1 || state === 'MULTIPLE_FACES') return bad('MULTIPLE_FACES', FEEDBACK.MULTIPLE_FACES)
  if (!face || state === 'NO_FACE') {
    return noFaceStreak >= config.noFaceHintAfter - 1
      ? bad('NO_FACE', FEEDBACK.NO_FACE_PERSISTENT)
      : bad('NO_FACE', FEEDBACK.NO_FACE)
  }

  if (local.brightness < config.brightnessMin || local.brightness > config.brightnessMax || state === 'TOO_DARK' || state === 'TOO_BRIGHT') {
    return bad('LIGHTING', FEEDBACK.LIGHTING)
  }
  if (state === 'FACE_TOO_SMALL' || face.width < config.sizeMin) return bad('TOO_FAR', FEEDBACK.TOO_FAR)
  if (face.width > config.sizeMax) return bad('TOO_CLOSE', FEEDBACK.TOO_CLOSE)

  const straight = pose === 'neutral' || !POSE_COPY[pose]
  if (straight) {
    if (Math.abs(face.cx - 0.5) > config.centerTolerance || Math.abs(face.cy - 0.5) > config.centerTolerance) {
      return bad('OFF_CENTER', FEEDBACK.OFF_CENTER)
    }
  } else if (
    face.cx < config.frameMargin || face.cx > 1 - config.frameMargin ||
    face.cy < config.frameMargin || face.cy > 1 - config.frameMargin
  ) {
    return bad('OUT_OF_FRAME', FEEDBACK.OUT_OF_FRAME)
  }

  if (local.motion > config.motionMax || local.sharpness < config.sharpnessMin || state === 'TOO_BLURRY') {
    return bad('HOLD_STILL', FEEDBACK.HOLD_STILL)
  }

  if (!straight && !relaxPose && !poseReached(pose, face, baseline, config)) {
    return bad('POSE', POSE_COPY[pose].retry)
  }
  return { ok: true, key: 'GOOD', message: FEEDBACK.GOOD }
}

/** True when the face box has moved far enough from the straight position in the direction the pose asks for. */
export function poseReached(pose, face, baseline, config = ENROLL_CONFIG) {
  const base = baseline ?? { cx: 0.5, cy: 0.5 }
  const { x, y } = config.poseShift
  // The camera image is not mirrored: turning to the user's left moves the face toward larger x.
  switch (pose) {
    case 'turn_left': return face.cx - base.cx >= x
    case 'turn_right': return base.cx - face.cx >= x
    case 'chin_up': return base.cy - face.cy >= y
    case 'chin_down': return face.cy - base.cy >= y
    default: return true
  }
}
