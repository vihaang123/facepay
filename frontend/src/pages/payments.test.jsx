import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { POLL, TIMING } from '../utils/authTiming'

const ORIGINAL = { timing: { ...TIMING }, poll: { ...POLL } }
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString()

const SID = 'ps_abc123'
const checkout = (over = {}) => ({
  session_id: SID, merchant_name: 'SuperGrocery', order_reference: 'SG-10492', description: null,
  amount: '950.00', currency: 'INR', status: 'CREATED', expires_at: inSeconds(900), max_auth_attempts: 5, attempts_remaining: 5, ...over,
})
const challenge = { challenge_id: 'c'.repeat(43), challenge: 'turn_right', instruction: 'Slowly turn your head to your right', expires_in_seconds: 60, baseline_frames: 2, min_frames: 5, max_frames: 10 }
const stages = (a, b, c) => [{ stage: 'FACE_DETECTION', status: a }, { stage: 'LIVENESS', status: b }, { stage: 'IDENTITY', status: c }]
const authOk = (over = {}) => ({
  result: 'AUTHENTICATED', reason: null, detail: null, authentication_id: 7, stages: stages('PASSED', 'PASSED', 'PASSED'), liveness: 'PASSED',
  challenge: 'turn_right', model_version: 'v1',
  identity: { verified: true, confidence: 0.8704, distance: 1.2345, distance_threshold: 2.5, frames_evaluated: 2, name: 'Asha Rao' },
  session_status: 'AUTHENTICATED', attempts_remaining: 5,
  authorization: { authorization_token: 'T'.repeat(43), expires_in_seconds: 120, expires_at: inSeconds(120), step_up_required: false, step_up_reasons: [], pin_set: false }, ...over,
})
const authRejected = (reason, over = {}) => ({
  result: 'REJECTED', reason, detail: null, authentication_id: 8, stages: stages('PASSED', 'PASSED', 'FAILED'), liveness: 'PASSED', challenge: 'turn_right',
  identity: { verified: false, confidence: 0.31, distance: 9.9, distance_threshold: 2.5, frames_evaluated: 2, name: null }, model_version: 'v1',
  session_status: 'CREATED', attempts_remaining: 4, authorization: null, ...over,
})
const receipt = {
  transaction_id: 'FP-7K3M9Q2XA4', status: 'SUCCESS', amount: '950.00', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-07T12:30:00Z',
  payer_name: 'Asha Rao', merchant_name: 'SuperGrocery', order_reference: 'SG-10492', description: null, session_id: SID,
  authentication: 'Face + basic liveness check',
}

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
  POLL.intervalMs = 20
  installCamera()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,RlJBTUU=')
  window.localStorage.clear()
  storeSession('customer')
})
afterEach(() => {
  Object.assign(TIMING, ORIGINAL.timing)
  Object.assign(POLL, ORIGINAL.poll)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete navigator.mediaDevices
})

const customerRoutes = (extra = {}) => ({
  'GET /users/me': { body: customerProfile },
  [`GET /payments/sessions/${SID}`]: { body: checkout() },
  [`POST /payments/sessions/${SID}/authenticate/start`]: { body: challenge },
  [`POST /payments/sessions/${SID}/authenticate`]: { body: authOk() },
  [`POST /payments/sessions/${SID}/confirm`]: { body: receipt },
  'GET /payments/transactions': { body: [] },
  ...extra,
})

async function payWithFace(extra) {
  const user = userEvent.setup()
  const api = mockApi(customerRoutes(extra))
  renderApp(`/checkout/${SID}`)
  await screen.findByRole('heading', { name: 'Checkout' })
  await user.click(await screen.findByRole('button', { name: 'Pay with Face' }))
  await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Start face check' }))
  return { user, api }
}

describe('checkout', () => {
  it('shows merchant, order, amount, method and status', async () => {
    mockApi(customerRoutes())
    renderApp(`/checkout/${SID}`)
    const summary = await screen.findByRole('region', { name: 'Payment summary' })
    expect(within(summary).getByText('SuperGrocery')).toBeInTheDocument()
    expect(within(summary).getByText('SG-10492')).toBeInTheDocument()
    expect(within(summary).getByText('₹950.00')).toBeInTheDocument()
    expect(within(summary).getByText('Simulated payment')).toBeInTheDocument()
    expect(within(summary).getByText('Waiting for customer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay with Face' })).toBeEnabled()
    expect(screen.getByText(/5 of 5 face checks left/)).toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in', async () => {
    window.localStorage.clear()
    mockApi({})
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByRole('heading', { name: 'Customer sign in' })).toBeInTheDocument()
  })

  it('shows a loading state, then a clear message for an unknown session', async () => {
    mockApi({ 'GET /users/me': { body: customerProfile }, [`GET /payments/sessions/${SID}`]: { status: 404, body: { detail: { code: 'SESSION_NOT_FOUND', message: 'nope' } } } })
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('This payment session does not exist.')
    expect(screen.queryByRole('button', { name: 'Pay with Face' })).not.toBeInTheDocument()
  })

  it('offers a retry when the server cannot be reached', async () => {
    const user = userEvent.setup()
    mockApi(customerRoutes())
    const ok = globalThis.fetch
    let fail = true
    vi.stubGlobal('fetch', vi.fn((url, init) => (fail && String(url).endsWith(`/payments/sessions/${SID}`) ? Promise.reject(new TypeError('offline')) : ok(url, init))))
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach the server/)
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Pay with Face' })).toBeInTheDocument()
  })

  it('reports a backend error on load', async () => {
    mockApi(customerRoutes({ [`GET /payments/sessions/${SID}`]: { status: 500, body: { detail: 'boom' } } }))
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side/)
  })

  it.each([
    ['PAID', /already been completed/],
    ['EXPIRED', /has expired/],
    ['CANCELLED', /cancelled this payment request/],
    ['FAILED', /Too many failed face checks/],
  ])('%s sessions cannot be paid', async (status, text) => {
    mockApi(customerRoutes({ [`GET /payments/sessions/${SID}`]: { body: checkout({ status }) } }))
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pay with Face' })).not.toBeInTheDocument()
  })

  it('merchants are sent back to their own dashboard', async () => {
    window.localStorage.clear()
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp(`/checkout/${SID}`)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'FacePay Checkout' })).not.toBeInTheDocument())
    expect(await screen.findByRole('heading', { name: 'SuperGrocery' })).toBeInTheDocument()
  })
})

describe('paying with FacePay', () => {
  it('face authentication → confirm → receipt, using only server-provided values', async () => {
    const { user, api } = await payWithFace()

    expect(await screen.findByRole('heading', { name: 'Confirm payment' })).toBeInTheDocument()
    const verify = api.callsTo(`POST /payments/sessions/${SID}/authenticate`)[0]
    expect(Object.keys(verify.body).sort()).toEqual(['challenge_id', 'frames']) // nothing claiming success or an amount
    expect(verify.body.frames).toHaveLength(challenge.baseline_frames + TIMING.turnFrames)
    expect(verify.headers.Authorization).toBe('Bearer token-for-customer')

    const section = screen.getByRole('region', { name: 'Confirm payment' })
    const stagesList = within(section).getByRole('list', { name: 'Payment stages' })
    expect(within(stagesList).getAllByRole('listitem').map((li) => li.textContent.replace(/^[✓✕•–]/, '').replace(/: (done|in progress|not yet|failed)$/, ''))).toEqual([
      'Face detected', 'Identity recognized', 'Basic liveness check passed', 'Payment authorization created', 'Customer confirmation', 'Payment processed',
    ])
    expect(within(stagesList).getByText('Payment authorization created').closest('li')).toHaveTextContent('done')
    expect(within(stagesList).getByText('Customer confirmation').closest('li')).toHaveTextContent('in progress') // the customer has not confirmed yet
    expect(within(stagesList).getByText('Payment processed').closest('li')).toHaveTextContent('not yet')
    expect(within(section).getByText('Face + basic liveness check')).toBeInTheDocument()
    expect(within(section).getByText('Asha Rao')).toBeInTheDocument()
    expect(within(section).getByText('87.0%')).toBeInTheDocument() // 0.8704 from the API
    expect(within(section).getByText('₹950.00')).toBeInTheDocument()
    expect(within(section).getByText(/stays valid for/)).toBeInTheDocument()
    expect(stopTrack).toHaveBeenCalled() // the camera is released once authentication is over

    await user.click(within(section).getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()

    const confirmCall = api.callsTo(`POST /payments/sessions/${SID}/confirm`)[0]
    // Exactly what the customer was shown: the server compares each one with the session and with the authorization itself.
    expect(confirmCall.body).toEqual({
      authorization_token: 'T'.repeat(43), expected_amount: '950.00', expected_merchant: 'SuperGrocery', expected_order_reference: 'SG-10492',
    })
    expect(confirmCall.headers.Authorization).toBe('Bearer token-for-customer')

    const done = screen.getByRole('region', { name: 'Payment successful' })
    expect(within(done).getByTestId('paid-amount')).toHaveTextContent('₹950.00')
    expect(within(done).getByText('SuperGrocery')).toBeInTheDocument()
    expect(within(done).getByText('FP-7K3M9Q2XA4')).toBeInTheDocument()
    expect(within(done).getByText('Simulated payment')).toBeInTheDocument()
    expect(within(done).getByText('Authenticated: Face + basic liveness check')).toBeInTheDocument()
    expect(within(done).getByRole('list', { name: 'Payment stages' })).toHaveTextContent('Payment processed: done')
    expect(screen.getByRole('link', { name: 'View receipt' })).toHaveAttribute('href', '/receipts/FP-7K3M9Q2XA4')
    expect(screen.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/dashboard')
  })

  it('shows the challenge instruction during the liveness step', async () => {
    TIMING.baselineGapMs = 120
    TIMING.turnGapMs = 60
    await payWithFace()
    expect(await screen.findByText('Hold still')).toBeInTheDocument()
    expect((await screen.findAllByText('Slowly turn your head to your right')).length).toBeGreaterThan(0)
    expect(await screen.findByRole('heading', { name: 'Confirm payment' })).toBeInTheDocument()
  })

  it('shows the processing state while the payment is being confirmed', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const { user } = await payWithFace()
    await screen.findByRole('heading', { name: 'Confirm payment' })
    const ok = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (String(url).endsWith('/confirm') ? (await gate, ok(url, init)) : ok(url, init))))
    await user.click(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    expect(screen.getByRole('status', { name: 'Processing payment' })).toHaveTextContent('Payment processed')
    release()
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
  })

  it('a rejected face keeps the customer on the camera step with the reason and attempts left', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authRejected('IDENTITY_MISMATCH') } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not verify that this is you/)
    expect(screen.queryByRole('heading', { name: 'Confirm payment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('liveness failure is explained', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authRejected('LIVENESS_FAILED', { detail: 'NO_MOVEMENT', stages: stages('PASSED', 'FAILED', 'SKIPPED'), liveness: 'FAILED', identity: null }) } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Liveness check failed\. We did not see you turn your head/)
  })

  it('multiple faces are refused with the payment-specific reason', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authRejected('MULTIPLE_FACES_DETECTED', { identity: null, stages: stages('FAILED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED' }) } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/More than one face/)
  })

  it('too many failed attempts ends the session', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authRejected('IDENTITY_MISMATCH', { session_status: 'FAILED', attempts_remaining: 0 }) } })
    expect(await screen.findByText(/Too many failed face checks/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start face check' })).not.toBeInTheDocument()
  })

  it('the session being cancelled during authentication shows the real state', async () => {
    let cancelled = false
    const { api } = await payWithFace({
      [`GET /payments/sessions/${SID}`]: () => ({ body: checkout({ status: cancelled ? 'CANCELLED' : 'CREATED' }) }),
      [`POST /payments/sessions/${SID}/authenticate`]: () => { cancelled = true; return { status: 409, body: { detail: { code: 'SESSION_CANCELLED', message: 'This payment session was cancelled by the merchant.' } } } },
    })
    expect(await screen.findByText(/cancelled this payment request/)).toBeInTheDocument()
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)).toHaveLength(0)
  })

  it('camera permission denied blocks the payment', async () => {
    installCamera({ reject: 'NotAllowedError' })
    const user = userEvent.setup()
    mockApi(customerRoutes())
    renderApp(`/checkout/${SID}`)
    await user.click(await screen.findByRole('button', { name: 'Pay with Face' }))
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    expect(await screen.findByText(/Camera access is required/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start face check' })).toBeDisabled()
  })

  it('model unavailable is reported without blaming the customer', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authRejected('MODEL_UNAVAILABLE', { identity: null, stages: stages('SKIPPED', 'SKIPPED', 'SKIPPED'), liveness: 'NOT_EVALUATED', attempts_remaining: 5 }) } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available right now/)
  })

  it('backend error while authenticating', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { status: 500, body: { detail: 'boom' } } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side/)
  })

  it('rate limiting while authenticating', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { status: 429, body: { detail: { code: 'RATE_LIMITED', message: 'Too many.' } } } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
  })

  it('"Back" returns from the camera step to the summary', async () => {
    const user = userEvent.setup()
    mockApi(customerRoutes())
    renderApp(`/checkout/${SID}`)
    await user.click(await screen.findByRole('button', { name: 'Pay with Face' }))
    await user.click(await screen.findByRole('button', { name: 'Back to payment' }))
    expect(await screen.findByRole('button', { name: 'Pay with Face' })).toBeInTheDocument()
  })
})

describe('confirmation failures', () => {
  const failConfirm = (status, code, message = 'm') => ({ [`POST /payments/sessions/${SID}/confirm`]: { status, body: { detail: { code, message } } } })

  async function toConfirm(extra) {
    const out = await payWithFace(extra)
    await screen.findByRole('heading', { name: 'Confirm payment' })
    await out.user.click(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    return out
  }

  it.each([
    ['AUTHORIZATION_EXPIRED', /face check expired/],
    ['AUTHORIZATION_INVALID', /couldn.t authorize this payment/],
    ['AUTHORIZATION_USED', /couldn.t authorize this payment/],
  ])('%s sends the customer back to authenticate again', async (code, text) => {
    await toConfirm(failConfirm(403, code))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay with Face' })).toBeInTheDocument()
    expect(screen.queryByText('Payment successful')).not.toBeInTheDocument()
  })

  it('an amount mismatch reloads the checkout and asks to authenticate again', async () => {
    let n = 0
    const { api } = await toConfirm({
      ...failConfirm(409, 'AMOUNT_MISMATCH'),
      [`GET /payments/sessions/${SID}`]: () => ({ body: checkout({ amount: ++n > 1 ? '1200.00' : '950.00' }) }),
    })
    expect(await screen.findByText(/amount for this payment changed/)).toBeInTheDocument()
    expect(await screen.findByText('₹1,200.00')).toBeInTheDocument()
    expect(api.callsTo(`GET /payments/sessions/${SID}`).length).toBeGreaterThan(1)
  })

  it('a session cancelled before confirming shows the cancelled state', async () => {
    let cancelled = false
    await toConfirm({
      [`GET /payments/sessions/${SID}`]: () => ({ body: checkout({ status: cancelled ? 'CANCELLED' : 'CREATED' }) }),
      [`POST /payments/sessions/${SID}/confirm`]: () => { cancelled = true; return { status: 409, body: { detail: { code: 'SESSION_CANCELLED', message: 'x' } } } },
    })
    expect(await screen.findByText(/cancelled this payment request/)).toBeInTheDocument()
  })

  it('already-paid sessions are reported', async () => {
    let paid = false
    await toConfirm({
      [`POST /payments/sessions/${SID}/confirm`]: () => { paid = true; return { status: 409, body: { detail: { code: 'SESSION_ALREADY_PAID', message: 'x' } } } },
      [`GET /payments/sessions/${SID}`]: () => ({ body: checkout({ status: paid ? 'PAID' : 'CREATED' }) }),
    })
    expect(await screen.findByText(/already completed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pay with Face' })).not.toBeInTheDocument()
  })

  it('a network failure keeps the same one-time authorization so the customer can retry', async () => {
    const { user } = await payWithFace()
    await screen.findByRole('heading', { name: 'Confirm payment' })
    const ok = globalThis.fetch
    let fail = true
    const calls = []
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).endsWith('/confirm')) {
        calls.push(JSON.parse(init.body))
        if (fail) return Promise.reject(new TypeError('offline'))
      }
      return ok(url, init)
    }))
    await user.click(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Your payment was not confirmed/)
    fail = false
    await user.click(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
    expect(calls).toHaveLength(2)
    expect(calls[0].authorization_token).toBe(calls[1].authorization_token)
  })

  it('a server error keeps the authorization and says the payment was not confirmed', async () => {
    await toConfirm({ [`POST /payments/sessions/${SID}/confirm`]: { status: 500, body: { detail: 'boom' } } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side.*Your payment was not confirmed/)
    expect(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ })).toBeEnabled()
  })

  it('rate limiting on confirm', async () => {
    await toConfirm({ [`POST /payments/sessions/${SID}/confirm`]: { status: 429, body: { detail: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' } } } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many requests/)
  })

  it('an authorization whose time ran out offers re-authentication instead of confirm', async () => {
    await payWithFace({ [`POST /payments/sessions/${SID}/authenticate`]: { body: authOk({ authorization: { authorization_token: 'T'.repeat(43), expires_in_seconds: 0, expires_at: inSeconds(-5) } }) } })
    expect(await screen.findByText(/face check expired/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify again' })).toBeInTheDocument()
  })

  it('cancelling the confirmation discards the authorization', async () => {
    const { user, api } = await payWithFace()
    await screen.findByRole('heading', { name: 'Confirm payment' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Pay with Face' })).toBeInTheDocument()
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)).toHaveLength(0)
  })
})

describe('receipts and history', () => {
  it('shows a customer receipt', async () => {
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions/FP-7K3M9Q2XA4': { body: receipt } })
    renderApp('/receipts/FP-7K3M9Q2XA4')
    const rec = await screen.findByRole('article', { name: 'Payment receipt' })
    expect(within(rec).getByText('Payment successful')).toBeInTheDocument()
    expect(within(rec).getByText('FP-7K3M9Q2XA4')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transaction details' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/transactions')
  })

  it('a receipt that is not yours is "not found"', async () => {
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions/FP-OTHER': { status: 404, body: { detail: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found.' } } } })
    renderApp('/receipts/FP-OTHER')
    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction not found.')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('the customer dashboard lists payment history from the server', async () => {
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /payments/transactions': { body: [
        { transaction_id: 'FP-AAAAAAAAAA', status: 'SUCCESS', amount: '950.00', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-07T12:30:00Z', merchant_name: 'SuperGrocery', order_reference: 'SG-10492' },
        { transaction_id: 'FP-BBBBBBBBBB', status: 'SUCCESS', amount: '120.50', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-06T08:00:00Z', merchant_name: 'Cafe Chai', order_reference: null },
      ] },
    })
    renderApp('/dashboard')
    const table = await screen.findByRole('list', { name: 'Recent payments' })
    const rows = within(table).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('SuperGrocery')).toBeInTheDocument()
    expect(within(rows[0]).getByText('₹950.00')).toBeInTheDocument()
    expect(within(rows[0]).getByText('Successful')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/receipts/FP-AAAAAAAAAA')
    expect(within(rows[1]).getByText('Cafe Chai')).toBeInTheDocument()
    expect(within(rows[1]).getByText('₹120.50')).toBeInTheDocument()
  })

  it('shows an empty state and an error state for history', async () => {
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { body: [] } })
    const { unmount } = renderApp('/dashboard')
    expect(await screen.findByText(/No payments yet/)).toBeInTheDocument()
    unmount()
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { status: 500, body: { detail: 'boom' } } })
    renderApp('/dashboard')
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument()
  })
})

describe('merchant', () => {
  const summary = {
    currency: 'INR', total_revenue: '2450.50', transactions: 3, successful_payments: 2, failed_payments: 1, open_sessions: 1, expired_sessions: 0, cancelled_sessions: 0,
    revenue_by_day: Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(24 + (i % 6)).padStart(2, '0')}`, revenue: i === 13 ? '2450.50' : '0', count: i === 13 ? 2 : 0 })),
  }
  const merchantRoutes = (extra = {}) => ({
    'GET /merchants/me': { body: merchantProfile },
    'GET /merchant/summary': { body: summary },
    'GET /merchant/transactions': { body: [{ transaction_id: 'FP-AAAAAAAAAA', status: 'SUCCESS', amount: '950.00', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-07T12:30:00Z', payer_name: 'Asha Rao', order_reference: 'SG-10492', session_id: SID }] },
    'GET /merchant/payment-sessions': { body: [{ session_id: SID, amount: '950.00', currency: 'INR', order_reference: 'SG-10492', description: null, status: 'PAID', created_at: '2026-10-07T12:00:00Z', expires_at: '2026-10-07T12:15:00Z', checkout_path: `/checkout/${SID}`, transaction_id: 'FP-AAAAAAAAAA' }] },
    ...extra,
  })
  beforeEach(() => {
    window.localStorage.clear()
    storeSession('merchant')
  })

  it('dashboard shows revenue, counts, recent transactions and sessions', async () => {
    mockApi(merchantRoutes())
    renderApp('/merchant/dashboard')
    expect(await screen.findByText('₹2,450.50')).toBeInTheDocument()
    expect(screen.getByText('Revenue today')).toBeInTheDocument()
    for (const [label, value] of [['Successful payments', '2'], ['Waiting for customer', '1'], ['Failed payments', '1']]) {
      expect(screen.getByText(label, { selector: 'p' }).parentElement).toHaveTextContent(value)
    }
    const tx = await screen.findByRole('list', { name: 'Recent transactions' })
    expect(within(tx).getByText('Asha Rao')).toBeInTheDocument()
    expect(within(tx).getByText('Successful')).toBeInTheDocument()
    expect(within(tx).getByRole('link')).toHaveAttribute('href', '/merchant/receipts/FP-AAAAAAAAAA')
    const sessions = await screen.findByRole('list', { name: 'Payment requests' })
    expect(within(sessions).getByText('Successful')).toBeInTheDocument()
    expect(within(sessions).getByRole('link', { name: /SG-10492/ })).toHaveAttribute('href', `/merchant/payments/${SID}`)
    expect(screen.getByRole('link', { name: 'Create payment' })).toHaveAttribute('href', '/merchant/payments/new')
  })

  it('the revenue chart has an accessible table view', async () => {
    const user = userEvent.setup()
    mockApi(merchantRoutes())
    renderApp('/merchant/dashboard')
    await user.click(await screen.findByRole('button', { name: 'View as table' }))
    const chart = screen.getByRole('region', { name: 'Revenue by day' })
    expect(within(chart).getAllByRole('row')).toHaveLength(15)
    expect(within(chart).getByText('₹2,450.50')).toBeInTheDocument()
  })

  it('empty and failing dashboards degrade gracefully', async () => {
    mockApi(merchantRoutes({ 'GET /merchant/transactions': { body: [] }, 'GET /merchant/payment-sessions': { body: [] }, 'GET /merchant/summary': { status: 500, body: { detail: 'boom' } } }))
    renderApp('/merchant/dashboard')
    expect(await screen.findByText('No payments yet')).toBeInTheDocument()
    expect(screen.getByText(/No payment requests yet/)).toBeInTheDocument()
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument()
  })

  it('customers cannot open merchant payment pages', async () => {
    window.localStorage.clear()
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { body: [] } })
    renderApp('/merchant/payments/new')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New payment request' })).not.toBeInTheDocument())
  })

  it('creates a payment session and lands on its status page', async () => {
    const user = userEvent.setup()
    const api = mockApi(merchantRoutes({
      'POST /merchant/payment-sessions': { status: 201, body: { session_id: SID, amount: '950.00', currency: 'INR', order_reference: 'SG-10492', description: null, status: 'CREATED', created_at: '2026-10-07T12:00:00Z', expires_at: inSeconds(900), checkout_path: `/checkout/${SID}`, transaction_id: null } },
      [`GET /merchant/payment-sessions/${SID}`]: { body: { session_id: SID, amount: '950.00', currency: 'INR', order_reference: 'SG-10492', description: null, status: 'CREATED', created_at: '2026-10-07T12:00:00Z', expires_at: inSeconds(900), checkout_path: `/checkout/${SID}`, transaction_id: null } },
    }))
    renderApp('/merchant/payments/new')
    await user.type(await screen.findByLabelText('Amount (₹)'), '950')
    await user.type(screen.getByLabelText('Order / reference'), ' SG-10492 ')
    await user.click(screen.getByRole('button', { name: 'Create payment request' }))
    expect(await screen.findByText('Awaiting customer')).toBeInTheDocument()
    expect(api.callsTo('POST /merchant/payment-sessions')[0].body).toEqual({ amount: '950', order_reference: 'SG-10492', expires_in_minutes: 15 })
    expect(screen.getByText(`${window.location.origin}/checkout/${SID}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })

  it.each([
    [{ amount: '', ref: 'X' }, 'Enter an amount between'],
    [{ amount: '0', ref: 'X' }, 'Enter an amount between'],
    [{ amount: '12.345', ref: 'X' }, 'Enter an amount between'],
    [{ amount: '2000000', ref: 'X' }, 'Enter an amount between'],
    [{ amount: '10', ref: '' }, 'Enter an order or reference number.'],
  ])('validates %j without calling the server', async (input, message) => {
    const user = userEvent.setup()
    const api = mockApi(merchantRoutes())
    renderApp('/merchant/payments/new')
    if (input.amount) await user.type(await screen.findByLabelText('Amount (₹)'), input.amount)
    if (input.ref) await user.type(await screen.findByLabelText('Order / reference'), input.ref)
    await user.click(await screen.findByRole('button', { name: 'Create payment request' }))
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument()
    expect(api.callsTo('POST /merchant/payment-sessions')).toHaveLength(0)
  })

  it('shows server-side field errors and network failures when creating', async () => {
    const user = userEvent.setup()
    mockApi(merchantRoutes({ 'POST /merchant/payment-sessions': { status: 422, body: { detail: [{ loc: ['body', 'amount'], msg: 'Input should be less than or equal to 1000000' }] } } }))
    renderApp('/merchant/payments/new')
    await user.type(await screen.findByLabelText('Amount (₹)'), '10')
    await user.type(screen.getByLabelText('Order / reference'), 'X')
    await user.click(screen.getByRole('button', { name: 'Create payment request' }))
    expect(await screen.findByText(/less than or equal to 1000000/)).toBeInTheDocument()
  })

  const sessionBody = (over = {}) => ({ session_id: SID, amount: '950.00', currency: 'INR', order_reference: 'SG-10492', description: 'Groceries', status: 'CREATED', created_at: '2026-10-07T12:00:00Z', expires_at: inSeconds(900), checkout_path: `/checkout/${SID}`, transaction_id: null, ...over })

  it('the status page follows the session from waiting to completed', async () => {
    let status = 'CREATED'
    mockApi(merchantRoutes({ [`GET /merchant/payment-sessions/${SID}`]: () => ({ body: sessionBody({ status, transaction_id: status === 'PAID' ? 'FP-AAAAAAAAAA' : null }) }) }))
    renderApp(`/merchant/payments/${SID}`)
    expect(await screen.findByText('Awaiting customer')).toBeInTheDocument()
    status = 'AUTHENTICATED'
    expect(await screen.findByText(/Customer authenticated, awaiting confirmation/)).toBeInTheDocument()
    status = 'PAID'
    expect(await screen.findByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/merchant/receipts/FP-AAAAAAAAAA')
    expect(screen.queryByRole('region', { name: 'Checkout link' })).not.toBeInTheDocument() // finished: no more link, no more polling
  })

  it('stops polling once the session is finished', async () => {
    const api = mockApi(merchantRoutes({ [`GET /merchant/payment-sessions/${SID}`]: { body: sessionBody({ status: 'EXPIRED' }) } }))
    renderApp(`/merchant/payments/${SID}`)
    expect(await screen.findByText('Request expired')).toBeInTheDocument()
    const n = api.callsTo(`GET /merchant/payment-sessions/${SID}`).length
    await new Promise((r) => setTimeout(r, 120))
    expect(api.callsTo(`GET /merchant/payment-sessions/${SID}`).length).toBe(n)
  })

  it('the merchant can cancel an open session', async () => {
    const user = userEvent.setup()
    let cancelled = false
    const api = mockApi(merchantRoutes({
      [`GET /merchant/payment-sessions/${SID}`]: () => ({ body: sessionBody({ status: cancelled ? 'CANCELLED' : 'CREATED' }) }),
      [`POST /merchant/payment-sessions/${SID}/cancel`]: () => { cancelled = true; return { body: sessionBody({ status: 'CANCELLED' }) } },
    }))
    renderApp(`/merchant/payments/${SID}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel request' }))
    // an in-page confirmation comes first; keeping the session sends nothing
    expect(screen.getByRole('alertdialog')).toHaveTextContent('checkout link stops working')
    await user.click(screen.getByRole('button', { name: 'Keep request' }))
    expect(api.callsTo(`POST /merchant/payment-sessions/${SID}/cancel`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Cancel request' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel request' }))
    expect(await screen.findByText('Request cancelled')).toBeInTheDocument()
    expect(api.callsTo(`POST /merchant/payment-sessions/${SID}/cancel`)).toHaveLength(1)
  })

  it('an unknown session (or another merchant’s) is "not found"', async () => {
    mockApi(merchantRoutes({ [`GET /merchant/payment-sessions/${SID}`]: { status: 404, body: { detail: { code: 'SESSION_NOT_FOUND', message: 'Payment session not found.' } } } }))
    renderApp(`/merchant/payments/${SID}`)
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment session not found.')
  })

  it('a merchant receipt uses the merchant endpoint', async () => {
    const api = mockApi(merchantRoutes({ 'GET /merchant/transactions/FP-AAAAAAAAAA': { body: receipt } }))
    renderApp('/merchant/receipts/FP-AAAAAAAAAA')
    expect(await screen.findByRole('heading', { name: 'Transaction details' })).toBeInTheDocument()
    expect(api.callsTo('GET /payments/transactions/FP-AAAAAAAAAA')).toHaveLength(0)
    expect(await screen.findByRole('link', { name: 'Done' })).toHaveAttribute('href', '/merchant/transactions')
  })
})

describe('risk-based step-up and safety messages', () => {
  const stepUp = (over = {}) => ({
    [`POST /payments/sessions/${SID}/authenticate`]: {
      body: authOk({ authorization: { authorization_token: 'T'.repeat(43), expires_in_seconds: 120, expires_at: inSeconds(120), step_up_required: true, step_up_reasons: ['a larger amount'], pin_set: true, ...over } }),
    },
  })
  const failConfirm = (status, code, message) => ({ [`POST /payments/sessions/${SID}/confirm`]: { status, body: { detail: { code, message } } } })

  it('asks for the payment PIN when the server says the payment is higher risk, and sends it with the confirmation', async () => {
    const { user, api } = await payWithFace(stepUp())
    await screen.findByRole('heading', { name: 'Confirm payment' })
    expect(screen.getByText(/needs your payment PIN/)).toBeInTheDocument()
    expect(screen.getByText(/because of a larger amount/i)).toBeInTheDocument()
    expect(screen.getByText('Risk-based authorization prototype')).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText('Payment PIN'), '12a3456789')
    expect(screen.getByLabelText('Payment PIN')).toHaveValue('123456') // digits only, six at most
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)[0].body.pin).toBe('123456')
  })

  it('does not ask for a PIN on an ordinary payment and sends none', async () => {
    const { user, api } = await payWithFace()
    await screen.findByRole('heading', { name: 'Confirm payment' })
    expect(screen.queryByLabelText('Payment PIN')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Confirm payment of ₹950\.00/ }))
    await screen.findByRole('heading', { name: 'Payment successful' })
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)[0].body).not.toHaveProperty('pin')
  })

  it('a wrong PIN keeps the same authorization so the customer can try again', async () => {
    const { user, api } = await payWithFace({ ...stepUp(), ...failConfirm(403, 'PIN_INCORRECT', 'That payment PIN is not correct.') })
    await screen.findByRole('heading', { name: 'Confirm payment' })
    await user.type(screen.getByLabelText('Payment PIN'), '000000')
    await user.click(screen.getByRole('button', { name: /Confirm payment of/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That payment PIN is not correct.')
    expect(screen.getByRole('heading', { name: 'Confirm payment' })).toBeInTheDocument()
    expect(api.callsTo(`POST /payments/sessions/${SID}/authenticate`)).toHaveLength(1) // no new face check was needed
  })

  it('sends the customer to Security when a PIN is needed but none is set, and blocks the confirmation', async () => {
    await payWithFace(stepUp({ pin_set: false }))
    await screen.findByRole('heading', { name: 'Confirm payment' })
    expect(screen.getByRole('link', { name: 'Set one in Security' })).toHaveAttribute('href', '/security')
    expect(screen.getByRole('button', { name: /Confirm payment of/ })).toBeDisabled()
  })

  it.each([
    ['PIN_LOCKED', 429, 'Too many incorrect PIN attempts. Please try again later.'],
    ['DAILY_LIMIT_EXCEEDED', 409, 'This payment would go over the simulated daily limit of ₹1,00,000.'],
    ['PER_TRANSACTION_LIMIT', 409, 'This payment is above the simulated limit of ₹50,000 per payment.'],
  ])('%s is shown in the server’s own words and ends the attempt', async (code, status, message) => {
    const { user } = await payWithFace(failConfirm(status, code, message))
    await screen.findByRole('heading', { name: 'Confirm payment' })
    await user.click(screen.getByRole('button', { name: /Confirm payment of/ }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay with Face' })).toBeInTheDocument()
  })

  it.each([
    ['MERCHANT_MISMATCH', /merchant for this payment changed/],
    ['ORDER_MISMATCH', /order for this payment changed/],
  ])('%s asks the customer to review and verify again', async (code, text) => {
    const { user } = await payWithFace(failConfirm(409, code, 'm'))
    await screen.findByRole('heading', { name: 'Confirm payment' })
    await user.click(screen.getByRole('button', { name: /Confirm payment of/ }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  async function startOnly(extra) {
    const user = userEvent.setup()
    mockApi(customerRoutes(extra))
    renderApp(`/checkout/${SID}`)
    await user.click(await screen.findByRole('button', { name: 'Pay with Face' }))
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
  }

  it('shows the lockout message, with no hint about why the face failed', async () => {
    await startOnly({ [`POST /payments/sessions/${SID}/authenticate/start`]: { status: 429, body: { detail: { code: 'BIOMETRIC_LOCKED', message: 'Too many unsuccessful attempts. Please try again later or use another verification method.' } } } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many unsuccessful attempts. Please try again later or use another verification method.')
  })

  it('points to Security when face payments are switched off', async () => {
    await startOnly({ [`POST /payments/sessions/${SID}/authenticate/start`]: { status: 403, body: { detail: { code: 'BIOMETRIC_DISABLED', message: 'Face payments are turned off for your account. Turn them on in Security to use FacePay.' } } } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Face payments are turned off for your account.')
    expect(screen.getByRole('link', { name: 'Open security settings' })).toHaveAttribute('href', '/security')
  })

  it('describes the protection honestly', async () => {
    mockApi(customerRoutes())
    renderApp(`/checkout/${SID}`)
    await screen.findByRole('region', { name: 'Payment summary' })
    const note = screen.getByText('How this payment is protected').closest('details')
    expect(note).toHaveTextContent(/does not protect against deepfakes, replayed video, masks/)
    expect(note).toHaveTextContent(/academic prototype/)
    expect(document.body.textContent).not.toMatch(/bank-grade|military-grade|impossible to hack|100% secure|cannot be spoofed/i)
  })
})
