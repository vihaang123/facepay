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

export function failureMessage(result) {
  if (result.reason === 'LIVENESS_FAILED') {
    return `Liveness check failed. ${LIVENESS_MESSAGES[result.detail] ?? ''}`.trim()
  }
  return REASON_MESSAGES[result.reason] ?? 'Authentication was rejected.'
}

// The server words these itself, in plain language, so the screen shows them as written.
const SERVER_WORDED = new Set([
  'BIOMETRIC_LOCKED', 'BIOMETRIC_DISABLED', 'PER_TRANSACTION_LIMIT', 'DAILY_LIMIT_EXCEEDED',
  'PIN_INCORRECT', 'PIN_LOCKED', 'PIN_REQUIRED', 'PIN_NOT_SET',
])

export function errorMessage(err) {
  if (err.code && SERVER_WORDED.has(err.code)) return err.message
  if (err.code === 'TIMEOUT') return 'The server took too long to respond. Please try again.'
  if (err.status === 0) return err.message
  if (err.status === 429) return 'Too many attempts. Please wait a minute and try again.'
  if (err.status === 403) return 'This account cannot use face authentication right now.'
  if (err.status >= 500) return 'Something went wrong on our side. Please try again.'
  return err.message
}


// ---- what kind of problem was it?
// A rejected face and a broken service are different things. Only a real decision by the server about the face is ever
// presented as "did not match"; connection and server trouble say so and tell the person nothing was decided about them.
const REASON_CATEGORY = {
  FACE_NOT_DETECTED: 'quality', MULTIPLE_FACES_DETECTED: 'quality', FACE_TOO_SMALL: 'quality', POOR_IMAGE_QUALITY: 'quality', INVALID_IMAGE: 'quality',
  LIVENESS_FAILED: 'liveness',
  IDENTITY_MISMATCH: 'mismatch', LOW_CONFIDENCE: 'mismatch', DISTANCE_TOO_HIGH: 'mismatch',
  NOT_ENROLLED: 'enrollment', MODEL_UNAVAILABLE: 'model',
  CHALLENGE_EXPIRED: 'challenge', CHALLENGE_INVALID: 'challenge', ACCOUNT_DISABLED: 'account',
}
export const CATEGORY_TITLES = {
  quality: 'Picture not clear enough',
  liveness: 'Liveness check not passed',
  mismatch: 'Face did not match',
  enrollment: 'Face setup needed',
  model: 'Recognition is unavailable',
  challenge: 'The check timed out',
  account: 'Account unavailable',
  camera: 'Camera problem',
  network: 'Connection problem',
  server: 'FacePay is having trouble',
  limit: 'Too many attempts',
  other: 'Face check stopped',
}

/** A decision about the face: { category, title, message }. */
export function classifyRejection(result) {
  const category = REASON_CATEGORY[result.reason] ?? 'other'
  const message = result.reason === 'MODEL_UNAVAILABLE'
    ? 'Face recognition is unavailable or needs to be retrained. This is not about your face. Set up your face again or try later.'
    : failureMessage(result)
  return { category, title: CATEGORY_TITLES[category], message }
}

/** A request that failed before any decision: { category, title, message }. Never reported as a mismatch. */
export function classifyError(err) {
  if (err?.code && SERVER_WORDED.has(err.code)) return { category: 'other', title: CATEGORY_TITLES.other, message: err.message }
  if (err?.code === 'TIMEOUT' || err?.status === 0) {
    return { category: 'network', title: CATEGORY_TITLES.network, message: `${errorMessage(err)} Nothing was decided about your face, so you can try again.` }
  }
  if (err?.status === 429) return { category: 'limit', title: CATEGORY_TITLES.limit, message: errorMessage(err) }
  if (err?.status >= 500) {
    return { category: 'server', title: CATEGORY_TITLES.server, message: 'Something went wrong on our side while checking your face. This is not a mismatch. Please try again in a moment.' }
  }
  return { category: 'other', title: CATEGORY_TITLES.other, message: errorMessage(err ?? {}) }
}
