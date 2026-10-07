import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { TIMING } from '../utils/authTiming'

const ORIGINAL_TIMING = { ...TIMING }
const challenge = {
  challenge_id: 'c'.repeat(43),
  challenge: 'turn_right',
  instruction: 'Slowly turn your head to your right',
  expires_in_seconds: 60,
  baseline_frames: 2,
  min_frames: 5,
  max_frames: 10,
}
const stages = (a, b, c) => [
  { stage: 'FACE_DETECTION', status: a },
  { stage: 'LIVENESS', status: b },
  { stage: 'IDENTITY', status: c },
]
const success = {
  result: 'AUTHENTICATED', reason: null, detail: null, authentication_id: 7, stages: stages('PASSED', 'PASSED', 'PASSED'),
  liveness: 'PASSED', challenge: 'turn_right', model_version: 'v1',
  identity: { verified: true, confidence: 0.8704, distance: 1.2345, distance_threshold: 2.5, frames_evaluated: 2, name: 'Asha Rao' },
}
const rejected = (reason, extra = {}) => ({
  result: 'REJECTED', reason, detail: null, authentication_id: 8, stages: stages('PASSED', 'PASSED', 'FAILED'),
  liveness: 'PASSED', challenge: 'turn_right', identity: null, model_version: 'v1', ...extra,
})

let stopTrack
function installCamera({ reject } = {}) {
  stopTrack = vi.fn()
  const getUserMedia = reject
    ? vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: reject }))
    : vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
}

beforeEach(() => {
  Object.assign(TIMING, { baselineGapMs: 1, turnGapMs: 1, turnFrames: 6, requestTimeoutMs: 2000 })
  installCamera()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,RlJBTUU=')
  storeSession('customer')
})
afterEach(() => {
  Object.assign(TIMING, ORIGINAL_TIMING)
  vi.restoreAllMocks()
  delete navigator.mediaDevices
})

const routes = (verify, extra = {}) => ({
  'GET /users/me': { body: customerProfile },
  'POST /face-auth/challenge': { body: challenge },
  'POST /face-auth/verify': verify,
  'GET /face-auth/attempts': { body: [] },
  ...extra,
})

async function openAndStart(verify, extra) {
  const user = userEvent.setup()
  const api = mockApi(routes(verify, extra))
  renderApp('/authenticate')
  await screen.findByRole('heading', { name: 'FacePay Authentication' })
  await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start authentication' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Start authentication' }))
  return { user, api }
}

describe('FacePay authentication screen', () => {
  it('cannot start until the camera is on', async () => {
    mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    expect(screen.getByRole('button', { name: 'Start authentication' })).toBeDisabled()
  })

  it('is linked from the customer navigation only', async () => {
    mockApi(routes({ body: success }))
    renderApp('/dashboard')
    expect(await screen.findByRole('link', { name: 'Authenticate' })).toHaveAttribute('href', '/authenticate')
  })

  it('merchants cannot open the page', async () => {
    window.localStorage.clear()
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/authenticate')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'FacePay Authentication' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Start authentication' })).not.toBeInTheDocument()
  })

  it('walks through look → liveness challenge → verify and shows the server’s real output', async () => {
    const { api } = await openAndStart({ body: success })
    expect(await screen.findByText('Authentication successful')).toBeInTheDocument()

    expect(api.callsTo('POST /face-auth/challenge')).toHaveLength(1)
    const call = api.callsTo('POST /face-auth/verify')[0]
    expect(call.body.challenge_id).toBe(challenge.challenge_id)
    expect(call.body.frames).toHaveLength(challenge.baseline_frames + TIMING.turnFrames)
    expect(call.body.frames.every((f) => f === 'RlJBTUU=')).toBe(true) // bare base64, no data: prefix
    expect(call.headers.Authorization).toBe('Bearer token-for-customer')

    const list = screen.getByRole('list', { name: 'Authentication stages' })
    expect(within(list).getByText('Face detected')).toBeInTheDocument()
    expect(within(list).getByText('Liveness verified')).toBeInTheDocument()
    expect(within(list).getByText('Identity verified')).toBeInTheDocument()
    expect(screen.getByText('Verified as:').closest('div')).toHaveTextContent('Asha Rao')
    expect(screen.getByText('87.0%')).toBeInTheDocument() // 0.8704 from the API, nothing else
    expect(screen.getByText(/1\.2345 \(limit 2\.5\)/)).toBeInTheDocument()
    expect(screen.getByText(/not a\s+calibrated probability/)).toBeInTheDocument()
  })

  it('shows the challenge instruction while the user performs it', async () => {
    TIMING.baselineGapMs = 150
    TIMING.turnGapMs = 60
    await openAndStart({ body: success })
    expect(await screen.findByText('Look at the camera')).toBeInTheDocument()
    expect(await screen.findByText('Slowly turn your head to your right')).toBeInTheDocument()
    expect(screen.getByText('Liveness check')).toBeInTheDocument()
    expect(await screen.findByText('Authentication successful')).toBeInTheDocument()
  })

  it.each([
    [rejected('FACE_NOT_DETECTED', { stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /could not find your face/],
    [rejected('MULTIPLE_FACES_DETECTED', { stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /More than one face/],
    [rejected('LIVENESS_FAILED', { detail: 'NO_MOVEMENT', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED' }), /Liveness check failed\. We did not see you turn your head/],
    [rejected('LIVENESS_FAILED', { detail: 'WRONG_DIRECTION', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED' }), /turned the wrong way/],
    [rejected('POOR_IMAGE_QUALITY', { detail: 'TOO_BLURRY', stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /not clear enough/],
    [rejected('MODEL_UNAVAILABLE', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /not available right now/],
    [rejected('CHALLENGE_EXPIRED', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /challenge expired/],
    [rejected('ACCOUNT_DISABLED', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /account is disabled/],
  ])('explains rejection %#', async (body, text) => {
    await openAndStart({ body })
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByText('Authentication successful')).not.toBeInTheDocument()
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument() // no identity result => no number shown
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it.each([
    ['IDENTITY_MISMATCH', /could not verify that this is you/, 0.31, 9.9],
    ['LOW_CONFIDENCE', /not confident enough/, 0.42, 1.1],
    ['DISTANCE_TOO_HIGH', /not close enough to your enrolled profile/, 0.9, 7.7],
  ])('recognition failure %s shows the real numbers but never the name', async (reason, text, confidence, distance) => {
    const identity = { verified: false, confidence, distance, distance_threshold: 2.5, frames_evaluated: 2, name: null }
    await openAndStart({ body: rejected(reason, { identity }) })
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.getByText(`${(confidence * 100).toFixed(1)}%`)).toBeInTheDocument()
    expect(screen.queryByText(/Verified as/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Authentication stages' })).getByText('Identity not verified')).toBeInTheDocument()
  })

  it('points users who are not in the model to face setup', async () => {
    await openAndStart({ body: rejected('NOT_ENROLLED', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }) })
    expect(await screen.findByRole('link', { name: 'Set up your face' })).toHaveAttribute('href', '/face')
  })

  it.each([
    [{ status: 500, body: { detail: 'boom' } }, /went wrong on our side/],
    [{ status: 429, body: { detail: { code: 'RATE_LIMITED', message: 'Too many.' } } }, /Too many attempts/],
    [{ status: 403, body: { detail: 'Account is disabled' } }, /cannot use face authentication/],
    [{ status: 422, body: { detail: [{ loc: ['body', 'frames'], msg: 'bad' }] } }, /highlighted fields|fix/i],
  ])('handles backend error %#', async (verify, text) => {
    await openAndStart(verify)
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByText('Authentication successful')).not.toBeInTheDocument()
  })

  it('reports an unreachable server', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start authentication' })).toBeEnabled())
    const ok = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).endsWith('/face-auth/verify') ? Promise.reject(new TypeError('offline')) : ok(url, init))))
    await user.click(screen.getByRole('button', { name: 'Start authentication' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the server/)
    expect(api.callsTo('POST /face-auth/challenge')).toHaveLength(1)
  })

  it('times out a hanging verification request', async () => {
    TIMING.requestTimeoutMs = 30
    const user = userEvent.setup()
    mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start authentication' })).toBeEnabled())
    const ok = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (!String(url).endsWith('/face-auth/verify')) return ok(url, init)
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }))
    await user.click(screen.getByRole('button', { name: 'Start authentication' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/took too long to respond/)
  })

  it('reports a blocked camera and does not allow starting', async () => {
    installCamera({ reject: 'NotAllowedError' })
    const user = userEvent.setup()
    mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    expect(await screen.findByText(/Camera access was blocked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start authentication' })).toBeDisabled()
  })

  it('"Try again" starts over with a fresh challenge', async () => {
    const { user, api } = await openAndStart({ body: rejected('IDENTITY_MISMATCH') })
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    await user.click(screen.getByRole('button', { name: 'Start authentication' }))
    await waitFor(() => expect(api.callsTo('POST /face-auth/challenge')).toHaveLength(2))
    await waitFor(() => expect(api.callsTo('POST /face-auth/verify')).toHaveLength(2))
  })

  it('lists recent attempts from the log after a result', async () => {
    await openAndStart({ body: success }, {
      'GET /face-auth/attempts': { body: [
        { id: 2, timestamp: '2026-10-07T12:00:00Z', result: 'FAILED', failure_reason: 'LIVENESS_FAILED' },
        { id: 1, timestamp: '2026-10-07T11:00:00Z', result: 'SUCCESS', failure_reason: null },
      ] },
    })
    const table = await screen.findByRole('region', { name: 'Recent attempts' })
    expect(within(table).getByText('LIVENESS_FAILED')).toBeInTheDocument()
    expect(within(table).getByText('Authenticated')).toBeInTheDocument()
  })

  it('stops capturing and never calls verify if the user leaves mid-attempt', async () => {
    TIMING.turnGapMs = 80
    const user = userEvent.setup()
    const api = mockApi(routes({ body: success }))
    const { unmount } = renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start authentication' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start authentication' }))
    await screen.findByText('Slowly turn your head to your right')
    unmount()
    await new Promise((r) => setTimeout(r, 700))
    expect(api.callsTo('POST /face-auth/verify')).toHaveLength(0)
    expect(stopTrack).toHaveBeenCalled()
  })

  it('never renders a picture of the user', async () => {
    await openAndStart({ body: success })
    await screen.findByText('Authentication successful')
    expect(document.querySelectorAll('img, canvas')).toHaveLength(0)
  })
})
