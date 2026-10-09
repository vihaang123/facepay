/**
 * The visible steps of a face check, derived only from what has really happened: the camera state, the model status the
 * server reported, the capture phase, and the server's stage results once it has answered. Nothing is animated for show
 * and no step is marked done early.
 *
 *   state: 'done' | 'current' | 'failed' | 'todo'
 *
 * Order: camera, face detected, image quality, model ready, liveness challenge, identity recognition, match decision,
 * then (for a payment) authorization and the customer's confirmation.
 */
const QUALITY_REASONS = new Set(['FACE_TOO_SMALL', 'POOR_IMAGE_QUALITY', 'INVALID_IMAGE'])

/** modelReady: true (the server said recognition can run), false (it said it cannot), null/undefined (not asked yet). */
export function liveStages({ cameraStatus, phase, result = null, authorized = false, modelReady = null }) {
  const stage = (name) => result?.stages?.find((s) => s.stage === name)?.status
  const answered = Boolean(result)
  const verifying = phase === 'verifying'
  const capturing = phase === 'baseline' || phase === 'turn'
  const reason = result?.reason

  const modelStage = stage('MODEL')
  const model = modelStage === 'FAILED' || modelReady === false ? 'failed'
    : modelStage === 'PASSED' || (modelReady === true) ? 'done'
    : answered && modelStage === undefined && stage('FACE_DETECTION') ? 'done' // older servers did not report this stage
    : 'todo'
  const blocked = model === 'failed' // when the model cannot run, no later step has happened

  const face = blocked ? 'todo' : !answered ? (verifying ? 'current' : 'todo')
    : stage('FACE_DETECTION') === 'PASSED' || QUALITY_REASONS.has(reason) ? 'done'
    : stage('FACE_DETECTION') === 'FAILED' ? 'failed' : 'todo'
  const quality = blocked ? 'todo' : !answered ? (verifying ? 'current' : 'todo')
    : QUALITY_REASONS.has(reason) ? 'failed'
    : stage('FACE_DETECTION') === 'PASSED' ? 'done' : 'todo'
  const liveness = blocked ? 'todo' : !answered ? (phase === 'turn' || verifying ? 'current' : 'todo')
    : stage('LIVENESS') === 'PASSED' ? 'done' : stage('LIVENESS') === 'FAILED' ? 'failed' : 'todo'
  const identity = blocked ? 'todo' : !answered ? (verifying ? 'current' : 'todo')
    : stage('IDENTITY') === 'PASSED' ? 'done' : stage('IDENTITY') === 'FAILED' ? 'failed' : 'todo'
  const match = identity === 'done' ? 'done' : identity === 'failed' ? 'failed' : 'todo'

  const cam = cameraStatus === 'active' ? 'done' : cameraStatus === 'requesting' ? 'current'
    : ['denied', 'error', 'unsupported'].includes(cameraStatus) ? 'failed' : 'todo'

  return [
    { key: 'camera', state: cam, label: { done: 'Camera ready', current: 'Starting camera', failed: 'Camera not available', todo: 'Camera' }[cam] },
    { key: 'face', state: face, label: { done: 'Face detected', current: 'Looking for your face', failed: 'Face not detected', todo: 'Face detection' }[face] },
    { key: 'quality', state: quality, label: { done: 'Image quality checked', current: 'Checking image quality', failed: 'Image quality too low', todo: 'Image quality check' }[quality] },
    { key: 'model', state: model, label: { done: 'Model ready', failed: 'Model not ready', todo: 'Recognition model' }[model] },
    { key: 'liveness', state: liveness, label: { done: 'Liveness challenge passed', current: 'Liveness challenge in progress', failed: 'Liveness challenge not passed', todo: 'Liveness challenge' }[liveness] },
    { key: 'identity', state: identity, label: { done: 'Identity recognized', current: 'Identity recognition in progress', failed: 'Identity not recognized', todo: 'Identity recognition' }[identity] },
    { key: 'match', state: match, label: { done: 'Match accepted', failed: 'Match rejected', todo: 'Match decision' }[match] },
    { key: 'authorization', state: authorized ? 'done' : 'todo', label: authorized ? 'Authorization created' : 'Authorization' },
    { key: 'confirm', state: authorized ? 'current' : 'todo', label: authorized ? 'Confirmation required' : 'Your confirmation' },
  ].map((row) => ({ ...row, capturing }))
}
