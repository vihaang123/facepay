// Capture timing for the authentication flow. Mutable on purpose so tests can run it instantly.
export const TIMING = {
  baselineGapMs: 400, // between the frames of the "look straight at the camera" phase
  turnFrames: 6, // frames captured while the user performs the challenge
  turnGapMs: 500, // => about 3 seconds to complete the turn
  requestTimeoutMs: 25000,
}

// Merchant payment-session page: how often it asks the server for the status while the session is open.
export const POLL = { intervalMs: 3000 }

// Finding someone by face: how many still frames are taken and how far apart. Mutable on purpose so tests can run it instantly.
export const SCAN = { frames: 3, gapMs: 250 }
