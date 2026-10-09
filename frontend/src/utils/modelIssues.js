// Reasons a face check cannot run. None of them is a decision about the person's face.
// The wording comes from the server (it is written to be shown); this file only says what to offer next.
export const MODEL_ISSUES = {
  ENROLLMENT_INSUFFICIENT: { next: 'ENROLL', title: 'Finish your face setup' },
  INSUFFICIENT_IDENTITIES: { next: 'WAIT_FOR_SECOND_PERSON', title: 'Recognition needs a second person' },
  MODEL_NOT_TRAINED: { next: 'TRAIN', title: 'Recognition model not ready' },
  MODEL_NOT_FOUND: { next: 'TRAIN', title: 'Recognition model not ready' },
  MODEL_STALE: { next: 'TRAIN', title: 'Recognition model needs updating' },
  MODEL_VERSION_INCOMPATIBLE: { next: 'TRAIN', title: 'Recognition model not ready' },
  MODEL_LOAD_FAILED: { next: 'TRAIN', title: 'Recognition model not ready' },
  BIOMETRIC_DECRYPTION_FAILED: { next: 'CONTACT_ADMIN', title: 'Recognition model not ready' },
  MODEL_UNAVAILABLE: { next: 'TRAIN', title: 'Recognition model not ready' }, // older servers
  NOT_ENROLLED: { next: 'ENROLL', title: 'Finish your face setup' }, // older servers
}

export const isModelIssue = (code) => Object.prototype.hasOwnProperty.call(MODEL_ISSUES, code)

export const MODEL_FALLBACK_MESSAGE = 'Face recognition is temporarily unavailable because the recognition model is not ready.'

/** A readiness-shaped object for a code that came back from a challenge or a verify call. */
export function notReady(code, message) {
  const info = MODEL_ISSUES[code] ?? { next: 'TRAIN', title: 'Recognition model not ready' }
  return { ready: false, code, message: message || MODEL_FALLBACK_MESSAGE, next_action: info.next }
}
