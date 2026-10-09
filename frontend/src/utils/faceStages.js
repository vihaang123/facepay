/**
 * The visible steps of a face check, derived only from what has really happened: the camera state, the capture phase, and
 * the server's stage results once it has answered. Nothing is animated for show and no step is marked done early.
 *
 *   state: 'done' | 'current' | 'failed' | 'todo'
 */
const QUALITY_REASONS = new Set(['FACE_TOO_SMALL', 'POOR_IMAGE_QUALITY', 'INVALID_IMAGE'])

export function liveStages({ cameraStatus, phase, result = null, authorized = false }) {
  const stage = (name) => result?.stages?.find((s) => s.stage === name)?.status
  const answered = Boolean(result)
  const verifying = phase === 'verifying'
  const capturing = phase === 'baseline' || phase === 'turn'
  const reason = result?.reason

  const face = !answered ? (verifying ? 'current' : 'todo')
    : stage('FACE_DETECTION') === 'PASSED' || QUALITY_REASONS.has(reason) ? 'done'
    : stage('FACE_DETECTION') === 'FAILED' ? 'failed' : 'todo'
  const quality = !answered ? (verifying ? 'current' : 'todo')
    : QUALITY_REASONS.has(reason) ? 'failed'
    : stage('FACE_DETECTION') === 'PASSED' ? 'done' : 'todo'
  const liveness = !answered ? (phase === 'turn' || verifying ? 'current' : 'todo')
    : stage('LIVENESS') === 'PASSED' ? 'done' : stage('LIVENESS') === 'FAILED' ? 'failed' : 'todo'
  const identity = !answered ? (verifying ? 'current' : 'todo')
    : stage('IDENTITY') === 'PASSED' ? 'done' : stage('IDENTITY') === 'FAILED' ? 'failed' : 'todo'

  const cam = cameraStatus === 'active' ? 'done' : cameraStatus === 'requesting' ? 'current'
    : ['denied', 'error', 'unsupported'].includes(cameraStatus) ? 'failed' : 'todo'

  return [
    { key: 'camera', state: cam, label: { done: 'Camera ready', current: 'Starting camera', failed: 'Camera not available', todo: 'Camera' }[cam] },
    { key: 'face', state: face, label: { done: 'Face detected', current: 'Looking for your face', failed: 'Face not detected', todo: 'Face detection' }[face] },
    { key: 'quality', state: quality, label: { done: 'Image quality checked', current: 'Checking image quality', failed: 'Image quality too low', todo: 'Image quality check' }[quality] },
    { key: 'liveness', state: liveness, label: { done: 'Basic liveness passed', current: 'Basic liveness in progress', failed: 'Basic liveness not passed', todo: 'Basic liveness check' }[liveness] },
    { key: 'identity', state: identity, label: { done: 'Identity matched', current: 'Identity recognition in progress', failed: 'Identity did not match', todo: 'Identity recognition' }[identity] },
    { key: 'authorization', state: authorized ? 'done' : 'todo', label: authorized ? 'Authorization created' : 'Authorization' },
    { key: 'confirm', state: authorized ? 'current' : 'todo', label: authorized ? 'Confirmation required' : 'Your confirmation' },
  ].map((row) => ({ ...row, capturing }))
}
