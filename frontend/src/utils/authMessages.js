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

export function errorMessage(err) {
  if (err.code === 'TIMEOUT') return 'The server took too long to respond. Please try again.'
  if (err.status === 0) return err.message
  if (err.status === 429) return 'Too many attempts. Please wait a minute and try again.'
  if (err.status === 403) return 'This account cannot use face authentication right now.'
  if (err.status >= 500) return 'Something went wrong on our side. Please try again.'
  return err.message
}

