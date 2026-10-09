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
  { stage: 'MODEL', status: 'PASSED' },
  { stage: 'FACE_DETECTION', status: a },
  { stage: 'LIVENESS', status: b },
  { stage: 'IDENTITY', status: c },
]
const success = {
  result: 'AUTHENTICATED', reason: null, detail: null, authentication_id: 7, stages: stages('PASSED', 'PASSED', 'PASSED'),
  liveness: 'PASSED', challenge: 'turn_right', model_version: 'v1',
  identity: { verified: true, frames_evaluated: 2, name: 'Asha Rao' },
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
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Start face check' }))
  return { user, api }
}

describe('FacePay authentication screen', () => {
  it('cannot start until the camera is on', async () => {
    mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    expect(screen.getByRole('button', { name: 'Start face check' })).toBeDisabled()
  })

  it('is linked from the customer navigation only', async () => {
    mockApi(routes({ body: success }))
    renderApp('/dashboard')
    expect(await screen.findByRole('link', { name: 'Try a test face check' })).toHaveAttribute('href', '/authenticate')
  })

  it('merchants cannot open the page', async () => {
    window.localStorage.clear()
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/authenticate')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'FacePay Authentication' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Start face check' })).not.toBeInTheDocument()
  })

  it('walks through look → liveness challenge → verify and shows the server’s real output', async () => {
    const { api } = await openAndStart({ body: success })
    expect(await screen.findByRole('heading', { name: 'Identity verified' })).toBeInTheDocument()

    expect(api.callsTo('POST /face-auth/challenge')).toHaveLength(1)
    const call = api.callsTo('POST /face-auth/verify')[0]
    expect(call.body.challenge_id).toBe(challenge.challenge_id)
    expect(call.body.frames).toHaveLength(challenge.baseline_frames + TIMING.turnFrames)
    expect(call.body.frames.every((f) => f === 'RlJBTUU=')).toBe(true) // bare base64, no data: prefix
    expect(call.headers.Authorization).toBe('Bearer token-for-customer')

    const list = screen.getByRole('list', { name: 'Authentication stages' })
    expect(within(list).getByText('Face detected')).toBeInTheDocument()
    expect(within(list).getByText('Basic liveness check passed')).toBeInTheDocument()
    expect(within(list).getByText('Identity recognized')).toBeInTheDocument()
    expect(screen.getByText('Verified as:').closest('div')).toHaveTextContent('Asha Rao')
    // the customer never sees scores, distances or thresholds
    expect(document.body.textContent).not.toMatch(/confidence|distance|threshold|calibrated|\d+\.\d%/i)
    const steps = screen.getByRole('list', { name: 'Face check steps' })
    for (const label of ['Camera ready', 'Face detected', 'Image quality checked', 'Model ready', 'Liveness challenge passed', 'Identity recognized', 'Match accepted', 'Authorization']) {
      expect(within(steps).getByText(label)).toBeInTheDocument()
    }
  })

  it('shows the challenge instruction while the user performs it', async () => {
    TIMING.baselineGapMs = 150
    TIMING.turnGapMs = 60
    await openAndStart({ body: success })
    expect(await screen.findByText('Hold still')).toBeInTheDocument()
    expect((await screen.findAllByText('Slowly turn your head to your right')).length).toBeGreaterThan(0)
    expect(screen.getByText('Quick security check')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Identity verified' })).toBeInTheDocument()
  })

  it.each([
    [rejected('FACE_NOT_DETECTED', { stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /could not find your face/],
    [rejected('MULTIPLE_FACES_DETECTED', { stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /More than one face/],
    [rejected('LIVENESS_FAILED', { detail: 'NO_MOVEMENT', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED' }), /Liveness check failed\. We did not see you turn your head/],
    [rejected('LIVENESS_FAILED', { detail: 'WRONG_DIRECTION', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED' }), /turned the wrong way/],
    [rejected('POOR_IMAGE_QUALITY', { detail: 'TOO_BLURRY', stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /not clear enough/],
    [rejected('CHALLENGE_EXPIRED', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /challenge expired/],
    [rejected('ACCOUNT_DISABLED', { stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), /account is disabled/],
  ])('explains rejection %#', async (body, text) => {
    await openAndStart({ body })
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByRole('heading', { name: 'Identity verified' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument() // no identity result => no number shown
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it.each([
    ['IDENTITY_MISMATCH', /couldn't match this face to the enrolled account/],
    ['LOW_CONFIDENCE', /not confident enough/],
    ['DISTANCE_TOO_HIGH', /not close enough to your enrolled profile/],
  ])('recognition failure %s is a mismatch, shows no scores and never the name', async (reason, text) => {
    const identity = { verified: false, frames_evaluated: 2, name: null }
    await openAndStart({ body: rejected(reason, { identity }) })
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('heading', { name: 'Face did not match' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/confidence:|distance|threshold|\d+\.\d%/i)
    expect(screen.queryByText(/Verified as/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Authentication stages' })).getByText('Identity not recognized')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Face check steps' })).getByText('Match rejected')).toBeInTheDocument()
  })

  it.each([
    [rejected('POOR_IMAGE_QUALITY', { stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }), 'Picture not clear enough'],
    [rejected('LIVENESS_FAILED', { detail: 'NO_MOVEMENT', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED' }), 'Liveness check not passed'],
  ])('names the kind of problem %#', async (body, title) => {
    await openAndStart({ body })
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Face did not match' })).not.toBeInTheDocument()
  })

  it.each([
    [{ status: 500, body: { detail: 'Traceback boom' } }, 'FacePay is having trouble', /not a mismatch/],
    [{ status: 429, body: {} }, 'Too many attempts', /Too many attempts/],
  ])('a failed request is never reported as a mismatch %#', async (verify, title, message) => {
    await openAndStart(verify)
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('heading', { name: 'Face did not match' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Traceback/)
  })

  it('an unreachable network is a connection problem, not a face problem', async () => {
    const api = mockApi(routes({ body: success }))
    vi.stubGlobal('fetch', vi.fn(async (u, init) => {
      if (String(u).endsWith('/face-auth/verify')) throw new TypeError('Failed to fetch')
      return api(u, init)
    }))
    const user = userEvent.setup()
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
    expect(await screen.findByRole('heading', { name: 'Connection problem' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was decided about your face/)
  })

  describe('when recognition cannot run', () => {
    const notReadyBody = (code, next, message = 'Face recognition is temporarily unavailable because the recognition model is not ready.') =>
      ({ ready: false, code, message, next_action: next, stale: false, model_version: null })
    const open = async (readiness, extra = {}) => {
      const user = userEvent.setup()
      const api = mockApi({ ...routes({ body: success }, extra), 'GET /faces/readiness': { body: readiness } })
      renderApp('/authenticate')
      await screen.findByRole('heading', { name: 'FacePay Authentication' })
      return { user, api }
    }

    it('says so before the camera opens, sends no frames and never calls it a mismatch', async () => {
      const { api } = await open(notReadyBody('MODEL_NOT_TRAINED', 'TRAIN'))
      expect(await screen.findByRole('heading', { name: 'Recognition model not ready' })).toBeInTheDocument()
      expect(within(screen.getByRole('region', { name: 'Recognition status' })).getByRole('status')).toHaveTextContent('Face recognition is temporarily unavailable because the recognition model is not ready.')
      expect(screen.getByText('Nothing was decided about your face.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Start face check' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Turn camera on' })).not.toBeInTheDocument()
      expect(screen.queryByText(/couldn't match/i)).not.toBeInTheDocument()
      expect(api.callsTo('POST /face-auth/challenge')).toHaveLength(0)
      expect(api.callsTo('POST /face-auth/verify')).toHaveLength(0)
      const model = within(screen.getByRole('list', { name: 'Face check steps' })).getByText('Model not ready')
      expect(model).toBeInTheDocument()
    })

    it('offers to prepare the model, then opens the camera once the server says it is ready', async () => {
      let ready = false
      const trained = []
      const user = userEvent.setup()
      mockApi({
        ...routes({ body: success }),
        'GET /faces/readiness': () => ({ body: ready ? { ready: true } : notReadyBody('MODEL_NOT_TRAINED', 'TRAIN') }),
        'POST /faces/train': () => { trained.push(1); ready = true; return { body: { ok: true } } },
      })
      renderApp('/authenticate')
      await user.click(await screen.findByRole('button', { name: 'Prepare recognition model' }))
      expect(await screen.findByRole('button', { name: 'Turn camera on' })).toBeInTheDocument()
      expect(trained).toHaveLength(1)
    })

    it('needs a second person: explains it and offers no training button', async () => {
      await open(notReadyBody('INSUFFICIENT_IDENTITIES', 'WAIT_FOR_SECOND_PERSON', 'The recognition model needs at least two people with a finished face setup.'))
      expect(await screen.findByRole('heading', { name: 'Recognition needs a second person' })).toBeInTheDocument()
      expect(screen.getByText(/never creates a second person/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Prepare recognition model' })).not.toBeInTheDocument()
    })

    it('points users with an unfinished setup to face setup', async () => {
      await open(notReadyBody('ENROLLMENT_INSUFFICIENT', 'ENROLL', 'Your face setup is not finished.'))
      expect(await screen.findByRole('link', { name: 'Finish face setup' })).toHaveAttribute('href', '/face')
    })

    it('shows the model panel, not a retry loop, when the server reports the model problem at verify time', async () => {
      const { api } = await openAndStart({ status: 409, body: { detail: { code: 'MODEL_STALE', message: 'The recognition model needs updating.', next_action: 'TRAIN' } } })
      expect(await screen.findByRole('heading', { name: 'Recognition model needs updating' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      expect(screen.queryByText(/couldn't match/i)).not.toBeInTheDocument()
      expect(api.callsTo('POST /face-auth/verify')).toHaveLength(1)
    })
  })

  it.each([
    [{ status: 500, body: { detail: 'boom' } }, /went wrong on our side/],
    [{ status: 429, body: { detail: { code: 'RATE_LIMITED', message: 'Too many.' } } }, /Too many attempts/],
    [{ status: 403, body: { detail: 'Account is disabled' } }, /cannot use face authentication/],
    [{ status: 422, body: { detail: [{ loc: ['body', 'frames'], msg: 'bad' }] } }, /highlighted fields|fix/i],
  ])('handles backend error %#', async (verify, text) => {
    await openAndStart(verify)
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByRole('heading', { name: 'Identity verified' })).not.toBeInTheDocument()
  })

  it('reports an unreachable server', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    const ok = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url, init) => (String(url).endsWith('/face-auth/verify') ? Promise.reject(new TypeError('offline')) : ok(url, init))))
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    const ok = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (!String(url).endsWith('/face-auth/verify')) return ok(url, init)
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }))
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/took too long to respond/)
  })

  it('reports a blocked camera and does not allow starting', async () => {
    installCamera({ reject: 'NotAllowedError' })
    const user = userEvent.setup()
    mockApi(routes({ body: success }))
    renderApp('/authenticate')
    await screen.findByRole('heading', { name: 'FacePay Authentication' })
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    expect(await screen.findByText(/Camera access is required/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start face check' })).toBeDisabled()
  })

  it('"Try again" starts over with a fresh challenge', async () => {
    const { user, api } = await openAndStart({ body: rejected('IDENTITY_MISMATCH') })
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
    await screen.findAllByText('Slowly turn your head to your right')
    unmount()
    await new Promise((r) => setTimeout(r, 700))
    expect(api.callsTo('POST /face-auth/verify')).toHaveLength(0)
    expect(stopTrack).toHaveBeenCalled()
  })

  it('never renders a picture of the user', async () => {
    await openAndStart({ body: success })
    await screen.findByRole('heading', { name: 'Identity verified' })
    expect(document.querySelectorAll('img, canvas')).toHaveLength(0)
  })
})
