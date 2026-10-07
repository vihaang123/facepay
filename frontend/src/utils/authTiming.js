// Capture timing for the authentication flow. Mutable on purpose so tests can run it instantly.
export const TIMING = {
  baselineGapMs: 400, // between the frames of the "look straight at the camera" phase
  turnFrames: 6, // frames captured while the user performs the challenge
  turnGapMs: 500, // => about 3 seconds to complete the turn
  requestTimeoutMs: 25000,
}
