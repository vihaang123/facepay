/**
 * Tunable values for guided face setup. Nothing in the UI hardcodes a timing or a threshold; change it here.
 * These only drive on-screen guidance. The server re-checks every frame and is the only judge of whether a sample is
 * accepted, so loosening a value here can never let a bad sample into the profile.
 */
export const ENROLL_CONFIG = {
  // pacing
  pollIntervalMs: 450,      // pause between live quality checks
  stableMs: 900,            // every condition must hold this long before a capture
  cooldownMs: 1300,         // minimum gap after a capture, so a sample is never taken twice in a row
  successFlashMs: 900,      // how long the "Captured" confirmation stays up
  successFlashReducedMs: 500,
  nextPoseMs: 1100,         // how long the next-pose prompt is shown on its own
  poseRelaxMs: 7000,        // after this long the head-position check is waived (everything else still applies)
  noFaceHintAfter: 6,       // consecutive "no face" checks before suggesting sunglasses / obstructions
  maxConsecutiveErrors: 5,  // network/server failures in a row before setup stops with an error

  // geometry, as fractions of the video frame
  centerTolerance: 0.14,    // how far the face centre may be from the middle (straight pose)
  frameMargin: 0.2,         // for turned poses: the face centre must stay within [margin, 1 - margin]
  sizeMin: 0.2,             // face width / frame width
  sizeMax: 0.62,
  poseShift: { x: 0.05, y: 0.04 }, // how far the face must move from the straight position for a turn or tilt

  // cheap local checks (UX only)
  brightnessMin: 50,
  brightnessMax: 210,
  sharpnessMin: 4,
  motionMax: 14,            // mean pixel change between two checks; above it the person is still moving
}

export const POSE_COPY = {
  neutral: { label: 'Straight', title: 'Look straight at the camera', hint: 'Keep your face inside the outline.', retry: 'Look straight at the camera' },
  turn_left: { label: 'Left', title: 'Slowly turn your head to the left', hint: 'Only a little. Keep your face in view.', retry: 'Turn a little more to the left' },
  turn_right: { label: 'Right', title: 'Slowly turn your head to the right', hint: 'Only a little. Keep your face in view.', retry: 'Turn a little more to the right' },
  chin_up: { label: 'Up', title: 'Lift your chin slightly', hint: 'A small tilt is enough.', retry: 'Lift your chin a little more' },
  chin_down: { label: 'Down', title: 'Lower your chin slightly', hint: 'A small tilt is enough.', retry: 'Lower your chin a little more' },
}

// Human wording for everything the guidance can say. No raw numbers are ever shown.
export const FEEDBACK = {
  CHECKING: 'Checking your camera view',
  NO_FACE: 'Face the camera',
  NO_FACE_PERSISTENT: 'Face the camera and remove sunglasses or anything covering your face',
  MULTIPLE_FACES: 'Only one face should be visible',
  TOO_FAR: 'Move a little closer',
  TOO_CLOSE: 'Move slightly farther away',
  OFF_CENTER: 'Center your face',
  OUT_OF_FRAME: 'Keep your face inside the frame',
  LIGHTING: 'Improve the lighting',
  HOLD_STILL: 'Hold still',
  OFFLINE: 'Connection problem. Check your network',
  BUSY: 'One moment',
  GOOD: 'Hold still',
}

// What the server says when it declines a captured sample.
export const SERVER_REJECTIONS = {
  NO_FACE: FEEDBACK.NO_FACE,
  MULTIPLE_FACES: FEEDBACK.MULTIPLE_FACES,
  FACE_TOO_SMALL: FEEDBACK.TOO_FAR,
  TOO_DARK: FEEDBACK.LIGHTING,
  TOO_BRIGHT: FEEDBACK.LIGHTING,
  TOO_BLURRY: FEEDBACK.HOLD_STILL,
  DUPLICATE_SAMPLE: 'Move slightly and hold still',
  RATE_LIMITED: 'Too many checks in a short time. Pausing for a moment',
}
