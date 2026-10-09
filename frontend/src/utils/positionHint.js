/**
 * Concrete framing advice from the server's stateless look at a preview frame (POST /faces/assess).
 *
 *   assess: { state, faces, face: { cx, cy, width, height } | null } where cx/cy/width are fractions of the frame
 *   returns { tone: 'ok' | 'warn', key, message }
 *
 * Phones are usually held low, which puts the face in the lower part of the picture, so "too low" gets its own advice.
 * The picture is mirrored on screen but not in the data, so sideways advice avoids saying left or right.
 */
export const FRAMING = { lowCy: 0.58, highCy: 0.34, offCenterCx: 0.14, minWidth: 0.2, maxWidth: 0.72 }

export function positionHint(assess) {
  const warn = (key, message) => ({ tone: 'warn', key, message })
  if (!assess) return null
  const { state, faces, face } = assess
  if (faces > 1 || state === 'MULTIPLE_FACES') return warn('MULTIPLE', 'More than one face is visible. Only you should be in front of the camera.')
  if (!face || state === 'NO_FACE') return warn('NO_FACE', "We can't see your face yet. Face the camera, in good light, with your whole face in the frame.")
  if (state === 'TOO_DARK' || state === 'TOO_BRIGHT') return warn('LIGHT', 'The light is not right. Face a window or lamp, and avoid a bright light behind you.')
  if (state === 'FACE_TOO_SMALL' || face.width < FRAMING.minWidth) return warn('FAR', 'Move a little closer so your face fills the oval.')
  if (face.width > FRAMING.maxWidth) return warn('CLOSE', 'Move back a little so your whole face fits in the frame.')
  if (face.cy > FRAMING.lowCy) return warn('LOW', 'Your face is too low in the frame. Raise the phone to eye level, or tilt it up a little.')
  if (face.cy < FRAMING.highCy) return warn('HIGH', 'Your face is too high in the frame. Lower the phone a little, or tilt it down.')
  if (Math.abs(face.cx - 0.5) > FRAMING.offCenterCx) return warn('OFF_CENTER', 'Move toward the middle of the frame.')
  if (state === 'TOO_BLURRY') return warn('BLUR', 'The picture is blurry. Hold the phone steady.')
  return { tone: 'ok', key: 'GOOD', message: 'Good. Your face is in position.' }
}
