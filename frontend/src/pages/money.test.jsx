import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIMING } from '../utils/authTiming'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession, tokenResponse } from '../test/helpers'

const ORIGINAL_TIMING = { ...TIMING }
afterEach(() => { vi.restoreAllMocks(); Object.assign(TIMING, ORIGINAL_TIMING) })
beforeEach(() => { window.localStorage.clear(); Object.assign(TIMING, { baselineGapMs: 1, turnGapMs: 1, turnFrames: 6, requestTimeoutMs: 2000 }) })

const me = { ...customerProfile, facepay_id: 'asha.rao@facepay' }
const ravi = { display_name: 'Ravi Shah', masked_id: 'ra***i@facepay', is_self: false }
const inHour = () => new Date(Date.now() + 3_600_000).toISOString()
const session = (over = {}) => ({
  session_id: 'ps_transfer1', kind: 'TRANSFER', merchant_name: null, recipient_name: 'Ravi Shah', recipient_facepay_id: 'ravi.shah@facepay', recipient_masked_id: 'ra***i@facepay',
  note: 'Cab fare', request_id: null, balance: '9500.00', order_reference: null, description: null, amount: '250.00', currency: 'INR', status: 'CREATED',
  expires_at: inHour(), max_auth_attempts: 5, attempts_remaining: 5, authorization_seconds: 120, ...over,
})
const request = (over = {}) => ({
  request_id: 'pr_abc', direction: 'INCOMING', status: 'PENDING', amount: '75.00', currency: 'INR', note: 'Movie', created_at: '2026-10-07T10:00:00Z',
  expires_at: '2026-10-14T10:00:00Z', resolved_at: null, counterparty_name: 'Ravi Shah', counterparty_masked_id: 'ra***i@facepay', payable: true, transaction_id: null,
  qr_payload: 'facepay:request/pr_abc', ...over,
})
const base = () => ({
  'GET /users/me': { body: me },
  'GET /wallet': { body: { balance: '9500.00', currency: 'INR', simulated: true, entries: [] } },
  'GET /facepay/contacts': { body: [] },
})

describe('role separation in the app', () => {
  it('sends an administrator to the ML Lab and a customer away from it', async () => {
    storeSession('admin')
    mockApi({ 'GET /users/me': { body: { ...me, role: 'admin' } }, 'GET /admin/ml/overview': { body: { model: null, training_status: 'no_model', dataset: { enrolled_customers: 0, stored_samples: 0, customers: 1 }, history: [], methodology: { caveat: 'Noisy.' } } } })
    const first = renderApp('/admin')
    expect(await screen.findByRole('heading', { name: 'ML Lab' })).toBeInTheDocument()
    expect(await screen.findByText('No model')).toBeInTheDocument()
    first.unmount()
    window.localStorage.clear()
    storeSession('customer')
    mockApi(base())
    renderApp('/admin')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'ML Lab' })).not.toBeInTheDocument())
    expect(await screen.findByTestId('facepay-id')).toBeInTheDocument() // bounced to the customer home
  })

  it('keeps merchants out of customer money screens and the ML Lab', async () => {
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /merchant/summary': { status: 500, body: {} }, 'GET /merchant/payment-sessions': { body: [] }, 'GET /merchant/transactions': { body: [] }, 'GET /merchant/security-summary': { body: { sessions: 0, paid: 0, closed_after_failed_face_checks: 0, cancelled: 0, expired: 0, face_verified_sessions: 0, paid_with_pin_step_up: 0, note: 'Aggregate only.' } } })
    for (const path of ['/send', '/admin', '/activity']) {
      const { unmount } = renderApp(path)
      expect(await screen.findByRole('heading', { name: 'SuperGrocery' })).toBeInTheDocument() // merchant home
      unmount()
    }
  })

  it('the customer navigation has no ML Lab and the admin navigation has no payments', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /activity': { body: [] }, 'GET /activity/counts': { body: { pending_incoming_requests: 0 } }, 'GET /faces/enrollment': { status: 500, body: {} }, 'GET /faces/model': { body: { model: null } }, 'GET /face-auth/attempts': { body: [] } })
    renderApp('/dashboard')
    const main = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(main).queryByText(/ML Lab/)).not.toBeInTheDocument()
    expect(within(main).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Send', 'Scan', 'Activity', 'Requests', 'My QR', 'Face profile', 'Security', 'Profile'])
  })

  it('signing in as an administrator lands on the ML Lab', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/login': { body: tokenResponse('admin') },
      'GET /users/me': { body: { ...me, role: 'admin' } },
      'GET /admin/ml/overview': { body: { model: null, training_status: 'no_model', dataset: { enrolled_customers: 0, stored_samples: 0, customers: 1 }, history: [], methodology: {} } },
    })
    renderApp('/login')
    await user.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'Str0ng!Passw0rd')
    await user.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('heading', { name: 'ML Lab' })).toBeInTheDocument()
  })
})

describe('Admin ML Lab', () => {
  const overview = {
    model: { version: 'v1', status: 'active', trained_at: '2026-10-07T10:00:00Z', classifier: 'pca_lda_knn', n_samples: 24, n_classes: 2, validation: 'group_kfold(k=4)', distance_threshold: 8.5, threshold_percentile: 70, knn_k: 3, dataset_fingerprint: 'abc123', stale: false },
    training_status: 'current', dataset: { enrolled_customers: 2, stored_samples: 24, customers: 3 }, history: [], methodology: { caveat: 'Few users, noisy numbers.' },
  }
  const analysis = {
    available: true, model_version: 'v1', deployed_classifier: 'pca_lda_knn',
    pca: { components: 3, explained_variance_ratio: [0.6, 0.25, 0.1], cumulative_variance: [0.6, 0.85, 0.95], total_explained: 0.95, config: {} },
    lda: null, class_separation: { pixel_space: { dim: 100, trace_within: 5, trace_between: 2, between_over_within: 0.4, fisher_criterion: null } },
    classifiers: { pca_lda_knn: { accuracy: 0.95, macro_precision: 0.95, macro_recall: 0.95, macro_f1: 0.94, predict_ms_per_sample: 1, n_evaluated: 24, confusion_matrix: [[11, 1], [0, 12]], classes: ['C1', 'C2'], deployed: true } },
  }
  const routes = (over = {}) => ({ 'GET /users/me': { body: { ...me, role: 'admin' } }, 'GET /admin/ml/overview': { body: overview }, 'GET /admin/ml/analysis': { body: analysis }, ...over })

  it('shows the real model overview, PCA table, anonymous confusion matrix and an honest benchmark caveat', async () => {
    const user = userEvent.setup()
    storeSession('admin')
    mockApi(routes({
      'GET /admin/ml/benchmark': { body: { available: true, scope: 'Offline benchmark on the public AT&T/ORL face set.', dataset: 'ORL', closed_set: { protocol: '5-fold', variants: { pca_knn: { accuracy: 0.9, macro_precision: 0.9, macro_recall: 0.9, macro_f1: 0.9 } } }, open_set: { setup: '20 splits', deployed_percentile: 70, by_threshold_percentile: [{ percentile: 70, false_reject_rate: 0.3, false_reject_rate_std: 0.1, far_random_claim: 0.1, far_random_claim_std: 0.05, far_predicted_identity: 0.02, far_predicted_identity_std: 0.01 }] }, liveness: { method: 'Synthetic', note: 'Known limitation.' } } },
    }))
    renderApp('/admin')
    expect(await screen.findByText('v1')).toBeInTheDocument()
    expect(screen.getByText('Few users, noisy numbers.')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'PCA' }))
    await user.click(await screen.findByRole('button', { name: 'View as table' }))
    expect(within(await screen.findByRole('table', { name: 'PCA variance' })).getAllByRole('row')).toHaveLength(4)

    await user.click(screen.getByRole('tab', { name: 'LDA and classifiers' }))
    const matrix = await screen.findByRole('table', { name: 'Confusion matrix' })
    expect(within(matrix).getAllByText('C1').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('asha.rao')

    await user.click(screen.getByRole('tab', { name: 'Error rates' }))
    expect(await screen.findByText(/not measured on this deployment|too few users to measure/i)).toBeInTheDocument()
    expect(screen.getByText(/Offline benchmark on the public AT&T\/ORL face set/)).toBeInTheDocument()
  })

  it('says so when there is no model instead of inventing numbers', async () => {
    const user = userEvent.setup()
    storeSession('admin')
    mockApi(routes({ 'GET /admin/ml/analysis': { body: { available: false, reason: 'NO_MODEL' } } }))
    renderApp('/admin')
    await user.click(await screen.findByRole('tab', { name: 'PCA' }))
    expect(await screen.findByText(/No model has been trained yet/)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'PCA variance' })).not.toBeInTheDocument()
  })

  it('shows live outcomes as counts and explains they are not error rates', async () => {
    const user = userEvent.setup()
    storeSession('admin')
    mockApi(routes({ 'GET /admin/ml/outcomes': { body: { days: 30, attempts: 5, successful: 3, failed: 2, failure_categories: [{ category: 'Liveness', count: 2 }], failure_reasons: [], per_day: [], note: 'Live counts. They are outcomes, not error rates.' } } }))
    renderApp('/admin')
    await user.click(await screen.findByRole('tab', { name: 'Live outcomes' }))
    expect(await screen.findByText(/not error rates/)).toBeInTheDocument()
    expect(within(await screen.findByRole('table', { name: 'Failure categories' })).getByText('Liveness')).toBeInTheDocument()
  })

  it('shows a retry when the lab cannot load', async () => {
    storeSession('admin')
    mockApi(routes({ 'GET /admin/ml/overview': { status: 500, body: {} } }))
    renderApp('/admin')
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('Send money', () => {
  it('resolves the recipient, then prepares the payment and opens the review', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({
      ...base(),
      'GET /facepay/resolve': { body: ravi },
      'POST /transfers': { status: 201, body: session() },
      'GET /payments/sessions/ps_transfer1': { body: session() },
    })
    renderApp('/send')
    await user.type(await screen.findByLabelText('Who are you paying?'), 'Ravi.Shah@facepay')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    const confirm = await screen.findByRole('region', { name: 'Confirm recipient' })
    expect(within(confirm).getByText('Ravi Shah')).toBeInTheDocument()
    expect(within(confirm).getByText('ra***i@facepay')).toBeInTheDocument()
    expect(confirm.textContent).not.toMatch(/@example\.com|\+91/) // name and masked ID only
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }))

    await user.type(await screen.findByLabelText('Amount (₹)'), '250')
    await user.type(screen.getByLabelText('Note (optional)'), 'Cab fare')
    expect(await screen.findByText(/Available: ₹9,500\.00/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review payment' }))

    const call = api.callsTo('POST /transfers')[0]
    expect(call.body).toEqual({ recipient_facepay_id: 'Ravi.Shah@facepay', amount: '250.00', note: 'Cab fare' })
    expect(call.headers['Idempotency-Key']).toMatch(/.{8,}/)
    // the review: recipient, amount, note and balance, before any face check
    expect(await screen.findByRole('heading', { name: 'Review payment' })).toBeInTheDocument()
    const summary = screen.getByRole('region', { name: 'Payment summary' })
    expect(within(summary).getByText('Ravi Shah')).toBeInTheDocument()
    expect(within(summary).getByTestId('checkout-amount')).toHaveTextContent('₹250.00')
    expect(within(summary).getByText('Cab fare')).toBeInTheDocument()
    expect(within(summary).getByRole('button', { name: /Pay with Face/ })).toBeInTheDocument()
  })

  it.each([['', 'Enter an amount.'], ['abc', 'Enter an amount like 250 or 250.50.'], ['0', 'The amount must be more than zero.'], ['-5', 'Enter an amount like 250 or 250.50.'], ['10.999', 'Enter an amount like 250 or 250.50.']])(
    'rejects the amount %j before calling the server',
    async (amount, message) => {
      const user = userEvent.setup()
      storeSession('customer')
      const api = mockApi({ ...base(), 'GET /facepay/resolve': { body: ravi } })
      renderApp('/send?to=ravi.shah%40facepay')
      const field = await screen.findByLabelText('Amount (₹)')
      if (amount) await user.type(field, amount)
      await user.click(screen.getByRole('button', { name: 'Review payment' }))
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(api.callsTo('POST /transfers')).toHaveLength(0)
    },
  )

  it('shows the server’s reason when it refuses (for example an insufficient balance) and keeps the form', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'GET /facepay/resolve': { body: ravi }, 'POST /transfers': { status: 409, body: { detail: { code: 'INSUFFICIENT_BALANCE', message: 'Your balance is too low for this payment.' } } } })
    renderApp('/send?to=ravi.shah%40facepay')
    await user.type(await screen.findByLabelText('Amount (₹)'), '99999')
    await user.click(screen.getByRole('button', { name: 'Review payment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your balance is too low for this payment.')
    expect(screen.getByLabelText('Amount (₹)')).toHaveValue('99999')
  })

  it('reports an unknown recipient and refuses your own ID', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'GET /facepay/resolve': ({ headers }) => ({ status: 404, body: { detail: { code: 'RECIPIENT_NOT_FOUND', message: 'x' } }, headers }) })
    const first = renderApp('/send')
    await user.type(await screen.findByLabelText('Who are you paying?'), 'nobody@facepay')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    expect(await screen.findByText(/No FacePay account has that ID/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Confirm recipient' })).not.toBeInTheDocument()
    first.unmount()

    mockApi({ ...base(), 'GET /facepay/resolve': { body: { display_name: 'Asha Rao', masked_id: 'as***a@facepay', is_self: true } } })
    renderApp('/send')
    await user.type(await screen.findByLabelText('Who are you paying?'), 'asha.rao@facepay')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    expect(await screen.findByText(/your own FacePay ID/)).toBeInTheDocument()
  })

  it('lists contacts from the server and an empty state when there are none', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /facepay/contacts': { body: [{ display_name: 'Ravi Shah', facepay_id: 'ravi.shah@facepay', masked_id: 'ra***i@facepay', last_activity_at: '2026-10-07T10:00:00Z' }] } })
    renderApp('/send')
    expect(await screen.findByRole('button', { name: /Ravi Shah/ })).toBeInTheDocument()
    window.localStorage.clear()
    storeSession('customer')
    mockApi(base())
    renderApp('/send')
    expect((await screen.findAllByText('No contacts yet')).length).toBeGreaterThan(0)
  })
})

describe('paying a person: checkout', () => {
  const challenge = { challenge_id: 'c'.repeat(43), challenge: 'turn_right', instruction: 'Slowly turn your head to your right', expires_in_seconds: 60, baseline_frames: 2, min_frames: 5, max_frames: 10 }
  const ok = {
    result: 'AUTHENTICATED', reason: null, detail: null, authentication_id: 7, liveness: 'PASSED', challenge: 'turn_right', model_version: 'v1', session_status: 'AUTHENTICATED', attempts_remaining: 5,
    stages: [{ stage: 'FACE_DETECTION', status: 'PASSED' }, { stage: 'LIVENESS', status: 'PASSED' }, { stage: 'IDENTITY', status: 'PASSED' }],
    identity: { verified: true, frames_evaluated: 2, name: 'Asha Rao' },
    authorization: { authorization_token: 'T'.repeat(43), expires_in_seconds: 120, expires_at: inHour(), step_up_required: false, step_up_reasons: [], pin_set: false },
  }

  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) }, configurable: true })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,RlJBTUU=')
  })
  afterEach(() => { delete navigator.mediaDevices })

  it('face check, review again, then confirm with the recipient the customer was shown; the receipt names the person', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const receipt = { transaction_id: 'FP-TRANSFER01', kind: 'TRANSFER', status: 'SUCCESS', amount: '250.00', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-07T12:30:00Z', payer_name: 'Asha Rao', payer_masked_id: 'as***a@facepay', merchant_name: null, recipient_name: 'Ravi Shah', recipient_masked_id: 'ra***i@facepay', order_reference: null, description: null, note: 'Cab fare', request_id: null, session_id: 'ps_transfer1', authentication: 'Face + basic liveness check' }
    const api = mockApi({
      ...base(),
      'GET /payments/sessions/ps_transfer1': { body: session() },
      'POST /payments/sessions/ps_transfer1/authenticate/start': { body: challenge },
      'POST /payments/sessions/ps_transfer1/authenticate': { body: ok },
      'POST /payments/sessions/ps_transfer1/confirm': { status: 200, body: receipt },
    })
    renderApp('/checkout/ps_transfer1')
    await user.click(await screen.findByRole('button', { name: /Pay with Face/ }))
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))

    const section = await screen.findByRole('region', { name: 'Confirm payment' })
    expect(within(section).getByText('Ravi Shah')).toBeInTheDocument() // shown again after the face check
    expect(within(section).getByTestId('confirm-amount')).toHaveTextContent('₹250.00')
    expect(within(section).getByText('Cab fare')).toBeInTheDocument()
    await user.click(within(section).getByRole('button', { name: /Confirm payment of ₹250\.00/ }))
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()

    expect(api.callsTo('POST /payments/sessions/ps_transfer1/confirm')[0].body).toEqual({ authorization_token: 'T'.repeat(43), expected_amount: '250.00', expected_recipient: 'ravi.shah@facepay' })
    expect(screen.getByText('Ravi Shah')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View receipt' })).toHaveAttribute('href', '/receipts/FP-TRANSFER01')
  })

  it('a payment that cannot be confirmed because of the balance says so and moves no money', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({
      ...base(),
      'GET /payments/sessions/ps_transfer1': { body: session() },
      'POST /payments/sessions/ps_transfer1/authenticate/start': { body: challenge },
      'POST /payments/sessions/ps_transfer1/authenticate': { body: ok },
      'POST /payments/sessions/ps_transfer1/confirm': { status: 409, body: { detail: { code: 'INSUFFICIENT_BALANCE', message: 'x' } } },
    })
    renderApp('/checkout/ps_transfer1')
    await user.click(await screen.findByRole('button', { name: /Pay with Face/ }))
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
    await user.click(await screen.findByRole('button', { name: /Confirm payment of/ }))
    expect(await screen.findByText(/balance is too low for this payment\. No money moved/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payment successful' })).not.toBeInTheDocument()
  })

  it('cancelling a prepared payment calls the server and returns home', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({
      ...base(),
      'GET /payments/sessions/ps_transfer1': { body: session() },
      'POST /transfers/ps_transfer1/cancel': { body: { session_id: 'ps_transfer1', status: 'CANCELLED' } },
      'GET /activity': { body: [] }, 'GET /activity/counts': { body: { pending_incoming_requests: 0 } }, 'GET /faces/enrollment': { status: 500, body: {} }, 'GET /faces/model': { body: { model: null } }, 'GET /face-auth/attempts': { body: [] },
    })
    renderApp('/checkout/ps_transfer1')
    await user.click(await screen.findByRole('button', { name: 'Cancel payment' }))
    expect(await screen.findByTestId('facepay-id')).toBeInTheDocument()
    expect(api.callsTo('POST /transfers/ps_transfer1/cancel')).toHaveLength(1)
  })

  it('an expired person-to-person payment says no money moved and offers no face check', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /payments/sessions/ps_transfer1': { body: session({ status: 'EXPIRED' }) } })
    renderApp('/checkout/ps_transfer1')
    expect(await screen.findByText(/expired before it was confirmed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pay with Face/ })).not.toBeInTheDocument()
  })
})

describe('Request money', () => {
  it('creates a request without any payment step', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({ ...base(), 'GET /facepay/resolve': { body: ravi }, 'POST /requests': { status: 201, body: request({ direction: 'OUTGOING' }) } })
    renderApp('/request')
    await user.type(await screen.findByLabelText('Who should pay you?'), 'ravi.shah@facepay')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    await user.click(within(await screen.findByRole('region', { name: 'Confirm recipient' })).getByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Amount (₹)'), '75')
    await user.type(screen.getByLabelText('Note (optional)'), 'Movie')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument()
    expect(api.callsTo('POST /requests')[0].body).toEqual({ payer_facepay_id: 'ravi.shah@facepay', amount: '75.00', note: 'Movie' })
    expect(screen.getByText(/Nothing has been taken from anyone/)).toBeInTheDocument()
    expect(api.calls.some((c) => c.key.includes('/transfers') || c.key.includes('/authenticate'))).toBe(false)
  })

  it('shows the server’s refusal, such as too many open requests', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'GET /facepay/resolve': { body: ravi }, 'POST /requests': { status: 429, body: { detail: { code: 'TOO_MANY_PENDING_REQUESTS', message: 'You already have 5 open requests with this person.' } } } })
    renderApp('/request?from=ravi.shah%40facepay')
    await user.click(await screen.findByRole('button', { name: 'Find' }))
    await user.click(within(await screen.findByRole('region', { name: 'Confirm recipient' })).getByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Amount (₹)'), '5')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have 5 open requests')
  })
})

describe('Requests list', () => {
  it('lets the asked customer pay (which opens the review), decline, and the asker cancel', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let incoming = [request()]
    const api = mockApi({
      ...base(),
      'GET /requests': ({ body, headers }) => ({ body: incoming, headers, req: body }),
      'POST /requests/pr_abc/pay': { status: 201, body: session({ request_id: 'pr_abc', amount: '75.00' }) },
      'POST /requests/pr_abc/decline': () => { incoming = [request({ status: 'DECLINED', payable: false, resolved_at: '2026-10-07T11:00:00Z' })]; return { body: incoming[0] } },
      'GET /payments/sessions/ps_transfer1': { body: session({ request_id: 'pr_abc', amount: '75.00' }) },
    })
    renderApp('/requests')
    expect(await screen.findByText('Ravi Shah asked you')).toBeInTheDocument()
    expect(screen.getByText('Movie')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('Declined')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pay' })).not.toBeInTheDocument()

    incoming = [request()]
    await user.click(screen.getByRole('tab', { name: 'You asked' }))
    await waitFor(() => expect(api.callsTo('GET /requests').length).toBeGreaterThan(1))
    await user.click(screen.getByRole('tab', { name: 'Asked of you' }))
    await user.click(await screen.findByRole('button', { name: 'Pay' }))
    expect(api.callsTo('POST /requests/pr_abc/pay')[0].headers['Idempotency-Key']).toMatch(/.{8,}/)
    expect(await screen.findByRole('heading', { name: 'Review payment' })).toBeInTheDocument() // paying always goes through review and the face check
    expect(screen.getByText(/Answers request/)).toBeInTheDocument()
  })

  it('has calm empty states for both lists', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'GET /requests': { body: [] } })
    renderApp('/requests')
    expect(await screen.findByText('Nobody has asked you for money')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'You asked' }))
    expect(await screen.findByText('You have not asked anyone yet')).toBeInTheDocument()
  })

  it('cancel is offered only on your own pending requests', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'GET /requests': { body: [request({ direction: 'OUTGOING' }), request({ request_id: 'pr_old', direction: 'OUTGOING', status: 'PAID', payable: false, transaction_id: 'FP-PAID000001', resolved_at: '2026-10-07T11:00:00Z' })] } })
    renderApp('/requests')
    await user.click(await screen.findByRole('tab', { name: 'You asked' }))
    expect(await screen.findAllByRole('button', { name: 'Cancel request' })).toHaveLength(1)
    expect(screen.getByText('FP-PAID000001')).toBeInTheDocument()
  })
})

describe('QR codes', () => {
  it('shows my QR from the server payload, with copy and download, and no secrets', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /facepay/me': { body: { facepay_id: 'asha.rao@facepay', masked_id: 'as***a@facepay', display_name: 'Asha Rao', qr_payload: 'facepay:pay/asha.rao@facepay', can_change: true, next_change_at: null } } })
    renderApp('/my-qr')
    const img = await screen.findByRole('img', { name: 'QR code for asha.rao@facepay' })
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(screen.getByRole('button', { name: /Copy ID/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Share/ })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Download QR/ })).toBeEnabled()
    expect(document.body.textContent).not.toMatch(/token|password|jwt/i)
  })

  it('scan: with no camera it falls back to typing the ID, and a resolved ID continues to Send', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({ ...base(), 'POST /facepay/qr/resolve': { body: { type: 'PAY', facepay_id: 'ravi.shah@facepay', recipient: ravi, request: null } }, 'GET /facepay/resolve': { body: ravi } })
    renderApp('/scan')
    expect(await screen.findByText(/cannot open a camera here/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Or enter a FacePay ID'), 'ravi.shah@facepay')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(api.callsTo('POST /facepay/qr/resolve')[0].body).toEqual({ payload: 'ravi.shah@facepay' })
    expect(await screen.findByRole('heading', { name: 'Send money' })).toBeInTheDocument()
    expect(await screen.findByText('Ravi Shah')).toBeInTheDocument()
  })

  it('scan: an invalid code is refused politely and your own code is not payable', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'POST /facepay/qr/resolve': { status: 422, body: { detail: { code: 'QR_INVALID', message: 'x' } } } })
    const first = renderApp('/scan')
    await user.type(await screen.findByLabelText('Or enter a FacePay ID'), 'https://evil.example/pay')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a FacePay QR code.')
    first.unmount()

    mockApi({ ...base(), 'POST /facepay/qr/resolve': { body: { type: 'PAY', facepay_id: 'asha.rao@facepay', recipient: { display_name: 'Asha Rao', masked_id: 'as***a@facepay', is_self: true }, request: null } } })
    renderApp('/scan')
    await user.type(await screen.findByLabelText('Or enter a FacePay ID'), 'asha.rao@facepay')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('That is your own QR code.')).toBeInTheDocument()
  })

  it('scan: a scanned request shows who is asking and for how much before anything can be paid', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ ...base(), 'POST /facepay/qr/resolve': { body: { type: 'REQUEST', facepay_id: null, recipient: null, request: request() } } })
    renderApp('/scan')
    await user.type(await screen.findByLabelText('Or enter a FacePay ID'), 'facepay:request/pr_abc')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    const found = await screen.findByRole('region', { name: 'Scanned request' })
    expect(within(found).getByText('Ravi Shah')).toBeInTheDocument()
    expect(within(found).getByText(/75\.00/)).toBeInTheDocument()
    expect(within(found).getByRole('button', { name: 'Review and pay' })).toBeInTheDocument()
  })
})

describe('Activity detail', () => {
  const detail = { ref: 'FP-TRANSFER01', kind: 'TRANSFER', direction: 'SENT', status: 'SUCCESS', counterparty_name: 'Ravi Shah', counterparty_masked_id: 'ra***i@facepay', amount: '250.00', currency: 'INR', timestamp: '2026-10-07T12:30:00Z', note: 'Cab fare', order_reference: null, sender_name: 'Asha Rao', sender_masked_id: 'as***a@facepay', recipient_name: 'Ravi Shah', recipient_masked_id: 'ra***i@facepay', payment_method: 'FacePay (simulated)', authentication: 'Face + basic liveness check', request_id: null }

  it('shows reference, sender, recipient, amount, currency, time, note, method, authentication and status', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /activity/FP-TRANSFER01': { body: detail } })
    renderApp('/activity/FP-TRANSFER01')
    const article = await screen.findByRole('article', { name: 'Activity details' })
    for (const text of ['FP-TRANSFER01', 'Asha Rao', 'Ravi Shah', 'Cab fare', 'FacePay (simulated)', 'Face + basic liveness check', 'INR', 'Successful']) {
      expect(within(article).getAllByText(text).length).toBeGreaterThan(0)
    }
    expect(within(article).getByText(/250\.00/)).toBeInTheDocument()
    expect(article.textContent).not.toMatch(/@example\.com/)
  })

  it('another customer’s record is simply not found', async () => {
    storeSession('customer')
    mockApi({ ...base(), 'GET /activity/FP-OTHER': { status: 404, body: { detail: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found.' } } } })
    renderApp('/activity/FP-OTHER')
    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction not found.')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })
})

describe('FacePay ID', () => {
  it('is shown on the profile and can be changed, with the server’s refusal shown inline', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let current = 'asha.rao@facepay'
    const api = mockApi({
      'GET /users/me': () => ({ body: { ...me, facepay_id: current } }),
      'GET /facepay/me': () => ({ body: { facepay_id: current, masked_id: 'x', display_name: 'Asha Rao', qr_payload: `facepay:pay/${current}`, can_change: true, next_change_at: null } }),
      'PUT /facepay/me': ({ body }) => (body.facepay_id === 'taken' ? { status: 409, body: { detail: { code: 'FACEPAY_ID_TAKEN', message: 'That FacePay ID is already taken.' } } } : (current = `${body.facepay_id}@facepay`, { body: {} })),
    })
    renderApp('/profile')
    expect(await screen.findByTestId('facepay-id')).toHaveTextContent('asha.rao@facepay')
    await user.click(await screen.findByRole('button', { name: 'Change ID' }))
    await user.type(screen.getByLabelText('New FacePay ID'), 'taken')
    await user.click(screen.getByRole('button', { name: 'Save ID' }))
    expect(await screen.findByText('That FacePay ID is already taken.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('New FacePay ID'))
    await user.type(screen.getByLabelText('New FacePay ID'), 'asha.new')
    await user.click(screen.getByRole('button', { name: 'Save ID' }))
    await waitFor(() => expect(screen.getByTestId('facepay-id')).toHaveTextContent('asha.new@facepay'))
    expect(api.callsTo('PUT /facepay/me').at(-1).body).toEqual({ facepay_id: 'asha.new' })
  })

  it('cannot be changed again during the cooldown', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: me }, 'GET /facepay/me': { body: { facepay_id: 'asha.rao@facepay', masked_id: 'x', display_name: 'Asha Rao', qr_payload: 'q', can_change: false, next_change_at: '2026-11-07T10:00:00Z' } } })
    renderApp('/profile')
    expect(await screen.findByRole('button', { name: 'Change ID' })).toBeDisabled()
    expect(screen.getByText(/You can change it again after/)).toBeInTheDocument()
  })
})
