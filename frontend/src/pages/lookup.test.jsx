import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { SCAN } from '../utils/authTiming'
import { validatePurpose, validateReference } from '../utils/reference'

const ORIGINAL_SCAN = { ...SCAN }
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString()

let getUserMedia
let stop
function installCamera({ reject } = {}) {
  stop = vi.fn()
  getUserMedia = reject
    ? vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: reject }))
    : vi.fn().mockResolvedValue({ getTracks: () => [{ stop }], getVideoTracks: () => [{ getSettings: () => ({ facingMode: 'environment' }) }] })
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  Object.assign(SCAN, { frames: 3, gapMs: 1 })
  installCamera()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,RlJBTUU=')
})
afterEach(() => {
  Object.assign(SCAN, ORIGINAL_SCAN)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete navigator.mediaDevices
})

const MATCH = { matched: true, reason: 'MATCH', message: null, lookup_token: 'fl_ticket-123456', expires_in_seconds: 180, person: { display_name: 'Ravi Shah', masked_id: 'ra***i@facepay' } }
const MISS = { matched: false, reason: 'NO_MATCH', message: 'No FacePay customer found. They may not have turned on “find me by face”.', lookup_token: null, expires_in_seconds: null, person: null }

describe('purpose and reference rules', () => {
  it('asks for a real reason and refuses scam scripts', () => {
    expect(validateReference('')).toMatch(/Say what this is for/)
    expect(validateReference('ab')).toMatch(/too short/)
    expect(validateReference('1234')).toMatch(/real reason/)
    expect(validateReference('aaaa')).toMatch(/real reason/)
    expect(validateReference('Send OTP to claim')).toMatch(/OTPs, PINs/)
    expect(validateReference('you won a lottery')).toMatch(/OTPs, PINs/)
    expect(validateReference('x'.repeat(81))).toMatch(/80 characters/)
    expect(validateReference('Order #14 groceries')).toBeNull()
    expect(validateReference('  Dinner   split, Friday ')).toBeNull()
    expect(validatePurpose('')).toMatch(/Choose/)
    expect(validatePurpose('GOODS')).toBeNull()
  })
})

describe('request money by scanning a face', () => {
  const routes = (over = {}) => ({ 'GET /users/me': { body: customerProfile }, 'GET /facepay/contacts': { body: [] }, ...over })

  it('opens the REAR camera, scans, shows the name and masked ID, then needs amount, purpose and reference', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi(routes({
      'POST /face-lookup': { body: MATCH },
      'POST /requests': ({ body }) => ({ status: 201, body: {
        request_id: 'pr_1', direction: 'OUTGOING', status: 'PENDING', amount: body.amount, currency: 'INR', note: body.note, purpose: body.purpose, purpose_label: 'Goods or shopping',
        source: 'FACE', created_at: new Date().toISOString(), expires_at: inDays(7), resolved_at: null, counterparty_name: 'Ravi Shah', counterparty_masked_id: 'ra***i@facepay', payable: false, transaction_id: null, qr_payload: 'facepay://request/pr_1',
      } }),
    }))
    renderApp('/request')
    expect(await screen.findByRole('tab', { name: 'Scan their face', selected: true })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ ideal: 'environment' }) // the back camera
    expect(screen.getByLabelText('Camera preview')).not.toHaveClass('-scale-x-100') // not mirrored: it shows the other person
    await user.click(await screen.findByRole('button', { name: 'Scan face' }))
    const confirm = await screen.findByRole('region', { name: 'Confirm the person found' })
    expect(confirm).toHaveTextContent('Ravi Shah')
    expect(confirm).toHaveTextContent('ra***i@facepay')
    expect(api.callsTo('POST /face-lookup')[0].body.frames).toHaveLength(3)
    expect(stop).toHaveBeenCalled() // the camera is turned off once someone is found
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }))

    // nothing can be sent without a purpose and a reference
    await user.type(await screen.findByLabelText('Amount (₹)'), '250')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByText('Choose what the money is for.')).toBeInTheDocument()
    expect(screen.getByText(/Say what this is for/)).toBeInTheDocument()
    expect(api.callsTo('POST /requests')).toHaveLength(0)
    await user.selectOptions(screen.getByLabelText('What is this for?'), 'GOODS')
    await user.type(screen.getByLabelText('Reference'), 'Send OTP now')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByText(/Do not ask for money for OTPs/)).toBeInTheDocument()
    expect(api.callsTo('POST /requests')).toHaveLength(0)
    await user.clear(screen.getByLabelText('Reference'))
    await user.type(screen.getByLabelText('Reference'), 'Order 14 groceries')
    await user.click(screen.getByRole('button', { name: 'Send request' }))

    await waitFor(() => expect(api.callsTo('POST /requests')).toHaveLength(1))
    expect(api.callsTo('POST /requests')[0].body).toEqual({ lookup_token: 'fl_ticket-123456', amount: '250.00', purpose: 'GOODS', note: 'Order 14 groceries' })
    const sent = await screen.findByRole('region', { name: 'Request sent' })
    expect(sent).toHaveTextContent('Goods or shopping')
    expect(sent).toHaveTextContent('Order 14 groceries')
  })

  it('explains a failed scan and lets the person try again, never naming anyone', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi(routes({ 'POST /face-lookup': { body: MISS } }))
    renderApp('/request')
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    await user.click(await screen.findByRole('button', { name: 'Scan face' }))
    expect(await screen.findByText(/No FacePay customer found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan face' })).toBeEnabled() // still on the camera, free to scan again
  })

  it('shows what to do when the camera is blocked', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    installCamera({ reject: 'NotAllowedError' })
    mockApi(routes())
    renderApp('/request')
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    expect(await screen.findByText(/Camera access is required/)).toBeInTheDocument()
  })

  it('still lets you ask by FacePay ID, with the same required purpose and reference', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi(routes({
      'GET /facepay/resolve': { body: { display_name: 'Ravi Shah', masked_id: 'ra***i@facepay', is_self: false } },
      'POST /requests': ({ body }) => ({ status: 201, body: { request_id: 'pr_2', status: 'PENDING', amount: body.amount, currency: 'INR', note: body.note, purpose: body.purpose, purpose_label: 'Splitting a bill', expires_at: inDays(7), counterparty_name: 'Ravi Shah' } }),
    }))
    renderApp('/request')
    await user.click(await screen.findByRole('tab', { name: 'FacePay ID' }))
    await user.type(await screen.findByLabelText('Who should pay you?'), 'ravi.shah@facepay')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await user.type(await screen.findByLabelText('Amount (₹)'), '90')
    await user.selectOptions(screen.getByLabelText('What is this for?'), 'BILL_SPLIT')
    await user.type(screen.getByLabelText('Reference'), 'Dinner at Cafe Zoe')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(api.callsTo('POST /requests')).toHaveLength(1))
    expect(api.callsTo('POST /requests')[0].body).toEqual({ payer_facepay_id: 'ravi.shah@facepay', amount: '90.00', purpose: 'BILL_SPLIT', note: 'Dinner at Cafe Zoe' })
  })
})

describe('a shop requests by face', () => {
  it('scans with the rear camera, then sends the request to that one customer and opens its status page', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    const api = mockApi({
      'GET /merchants/me': { body: merchantProfile }, 'GET /users/me': { body: merchantProfile },
      'POST /face-lookup': { body: MATCH },
      'POST /merchant/payment-sessions/by-face': ({ body }) => ({ status: 201, body: { session_id: 'ps_face1', amount: body.amount, currency: 'INR', order_reference: body.order_reference, description: null, status: 'CREATED', created_at: new Date().toISOString(), expires_at: inDays(0.01), checkout_path: '/checkout/ps_face1', requested_from: 'Ravi Shah', requested_from_masked_id: 'ra***i@facepay', purpose: body.purpose, purpose_label: 'Goods or shopping' } }),
      'GET /merchant/payment-sessions/ps_face1': { body: { session_id: 'ps_face1', amount: '480.00', currency: 'INR', order_reference: 'Bill 2231 groceries', description: null, status: 'CREATED', created_at: new Date().toISOString(), expires_at: inDays(0.01), checkout_path: '/checkout/ps_face1', requested_from: 'Ravi Shah', requested_from_masked_id: 'ra***i@facepay', purpose: 'GOODS', purpose_label: 'Goods or shopping', transaction_id: null, paid_at: null } },
    })
    renderApp('/merchant/payments/face')
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ ideal: 'environment' })
    await user.click(await screen.findByRole('button', { name: 'Scan face' }))
    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Requesting from')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount (₹)'), '480')
    await user.selectOptions(screen.getByLabelText('What is this for?'), 'GOODS')
    await user.type(screen.getByLabelText('Reference'), 'Bill 2231 groceries')
    await user.click(screen.getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(api.callsTo('POST /merchant/payment-sessions/by-face')).toHaveLength(1))
    expect(api.callsTo('POST /merchant/payment-sessions/by-face')[0].body).toEqual({ lookup_token: 'fl_ticket-123456', amount: '480.00', purpose: 'GOODS', order_reference: 'Bill 2231 groceries' })
    expect(await screen.findByText(/has this request as a pop-up/)).toBeInTheDocument()
    expect(screen.queryByText('Copy link')).not.toBeInTheDocument() // addressed to one customer: no public link to share
  })
})

describe('the incoming request pop-up', () => {
  const item = (over = {}) => ({
    kind: 'REQUEST', ref: 'pr_7', from_name: 'Asha Rao', from_detail: 'as***o@facepay', amount: '250.00', currency: 'INR',
    purpose: 'BILL_SPLIT', purpose_label: 'Splitting a bill', reference: 'Dinner at Cafe Zoe', created_at: new Date().toISOString(), expires_at: inDays(2), ...over,
  })
  const base = (list, over = {}) => ({ 'GET /users/me': { body: customerProfile }, 'GET /requests/incoming/prompts': () => ({ body: list.current }), ...over })

  it('shows who, how much, what for and the reference, and warns about scams', async () => {
    storeSession('customer')
    mockApi(base({ current: [item()] }))
    renderApp('/dashboard')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Asha Rao is asking for money')
    expect(dialog).toHaveTextContent('₹250.00')
    expect(dialog).toHaveTextContent('Splitting a bill')
    expect(dialog).toHaveTextContent('Dinner at Cafe Zoe')
    expect(dialog).toHaveTextContent('FacePay never asks for OTPs, PINs or passwords')
    expect(dialog).toHaveTextContent('verify your face')
  })

  it('"Review and pay" starts the normal payment (no money moves from the pop-up)', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi(base({ current: [item()] }, {
      'POST /requests/pr_7/pay': { status: 201, body: { session_id: 'ps_t1', kind: 'TRANSFER', amount: '250.00', currency: 'INR', status: 'CREATED', funding_sources: [] } },
      'GET /payments/sessions/ps_t1': { body: { session_id: 'ps_t1', kind: 'TRANSFER', amount: '250.00', currency: 'INR', status: 'CREATED', recipient_name: 'Asha Rao', funding_sources: [], max_auth_attempts: 5, attempts_remaining: 5, authorization_seconds: 120, expires_at: inDays(0.01), order_reference: null, description: null } },
    }))
    renderApp('/dashboard')
    await user.click(await screen.findByRole('button', { name: 'Review and pay' }))
    await waitFor(() => expect(api.callsTo('POST /requests/pr_7/pay')).toHaveLength(1))
    expect(api.calls.some((c) => c.key.includes('/confirm'))).toBe(false)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('a shop bill opens its checkout; Decline says no; Not now hides it for this session', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const list = { current: [item({ kind: 'SHOP', ref: 'ps_9', from_name: 'SuperGrocery', from_detail: 'Shop', purpose: 'GOODS', purpose_label: 'Goods or shopping', reference: 'Bill 2231' })] }
    const api = mockApi(base(list, { 'POST /payments/sessions/ps_9/decline': { body: { session_id: 'ps_9', status: 'CANCELLED' } } }))
    renderApp('/dashboard')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('SuperGrocery is asking for money')
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(api.callsTo('POST /payments/sessions/ps_9/decline')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('Not now closes it and it stays closed on the next check', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi(base({ current: [item()] }))
    renderApp('/dashboard')
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }) // the app comes back to the front: it checks again
    await waitFor(() => expect(api.callsTo('GET /requests/incoming/prompts').length).toBeGreaterThan(1))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not interrupt a payment in progress and is never shown to a shop', async () => {
    storeSession('merchant')
    const api = mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /users/me': { body: merchantProfile }, 'GET /requests/incoming/prompts': { body: [item()] } })
    renderApp('/merchant/dashboard')
    await screen.findByRole('heading', { name: 'SuperGrocery' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.callsTo('GET /requests/incoming/prompts')).toHaveLength(0)
  })
})

describe('find me by face setting', () => {
  it('is off by default, explains what it does, and turns on with one switch', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let on = false
    const overview = () => ({ body: {
      face_lookup_enabled: on, biometric_enabled: true, face_enrolled: true, samples_stored: 15, last_successful_authentication: null, biometric_locked_seconds: 0, pin_set: false, pin_locked_seconds: 0,
      recent_attempts: [], recent_transactions: [], recent_events: [{ kind: 'FACE_LOOKUP_MATCH', timestamp: new Date().toISOString(), session_ref: null }],
      limits: { currency: 'INR', per_transaction: '50000', daily: '100000', spent_last_24h: '0', step_up_amount: '10000', authorization_seconds: 120 }, risk_label: 'Low',
    } })
    const api = mockApi({
      'GET /users/me': { body: customerProfile }, 'GET /security/overview': overview,
      'PUT /security/face-lookup': ({ body }) => { on = body.enabled; return overview() },
    })
    renderApp('/security')
    const sw = await screen.findByRole('switch', { name: 'Let shops and friends find me by face' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Nobody can find you with a camera/)).toBeInTheDocument()
    expect(screen.getByText(/Finding you never takes money/)).toBeInTheDocument()
    expect(screen.getByText('Someone found you by face scan')).toBeInTheDocument()
    await user.click(sw)
    await waitFor(() => expect(api.callsTo('PUT /security/face-lookup')[0].body).toEqual({ enabled: true }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Let shops and friends find me by face' })).toHaveAttribute('aria-checked', 'true'))
  })
})

describe('requests page', () => {
  it('keeps a shop bill findable after the pop-up was dismissed', async () => {
    storeSession('customer')
    mockApi({
      'GET /users/me': { body: customerProfile }, 'GET /requests': { body: [] },
      'GET /requests/incoming/prompts': { body: [{ kind: 'SHOP', ref: 'ps_9', from_name: 'SuperGrocery', from_detail: 'Shop', amount: '480.00', currency: 'INR', purpose: 'GOODS', purpose_label: 'Goods or shopping', reference: 'Bill 2231', created_at: new Date().toISOString(), expires_at: inDays(0.01) }] },
    })
    renderApp('/requests')
    const bills = await screen.findByRole('region', { name: 'Bills from shops' })
    expect(bills).toHaveTextContent('SuperGrocery asked you')
    expect(bills).toHaveTextContent('Bill 2231')
    expect(within(bills).getByRole('link', { name: 'Review and pay' })).toHaveAttribute('href', '/checkout/ps_9')
  })
})
