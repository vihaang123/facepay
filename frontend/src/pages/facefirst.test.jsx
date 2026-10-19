import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { POLL, TIMING } from '../utils/authTiming'

const ORIGINAL = { timing: { ...TIMING }, poll: { ...POLL } }
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString()
const DISCLAIMER = 'Demo connection only. No real bank account is accessed and no money is transferred.'

const conn = (id, bank, over = {}) => ({
  connection_id: id, bank_code: bank.toLowerCase(), bank_name: `${bank} Bank`, account_type: 'SAVINGS', account_type_label: 'Savings account',
  account_ref: 'DEMO-••••-4821', is_default: false, status: 'CONNECTED', connected_at: '2026-10-07T10:00:00Z', disclaimer: DISCLAIMER, ...over,
})
const CATALOG = {
  banks: [
    { code: 'sbi', name: 'State Bank of India', short: 'SBI', color: '#1d4f91' },
    { code: 'hdfc', name: 'HDFC Bank', short: 'HDFC', color: '#0b3d7a' },
  ],
  account_types: [{ code: 'SAVINGS', label: 'Savings account' }, { code: 'CURRENT', label: 'Current account' }],
  max_connected: 5, disclaimer: DISCLAIMER,
}

beforeEach(() => { window.localStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('connected bank accounts', () => {
  const routes = (over = {}) => ({ 'GET /users/me': { body: customerProfile }, 'GET /banks/catalog': { body: CATALOG }, 'GET /banks': { body: [conn('bk_1', 'HDFC', { is_default: true }), conn('bk_2', 'ICICI')] }, ...over })

  it('lists the demo accounts with their masked references, a default marker and the disclaimer', async () => {
    storeSession('customer')
    mockApi(routes())
    renderApp('/banks')
    const list = await screen.findByRole('list', { name: 'Connected bank accounts' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list).toHaveTextContent('HDFC Bank')
    expect(list).toHaveTextContent('DEMO-••••-4821')
    expect(within(list).getAllByText('Demo connected')).toHaveLength(2)
    expect(within(list).getAllByText('Default')).toHaveLength(1)
    expect(screen.getAllByText(DISCLAIMER).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/₹\s?\d/) // a linked bank is never shown with an amount or as proof of funds
  })

  it('connects a bank by choosing it and a demo profile, sends only codes, and never asks for credentials', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let banks = []
    const api = mockApi(routes({
      'GET /banks': () => ({ body: banks }),
      'POST /banks': ({ body }) => { banks = [conn('bk_9', 'SBI', { is_default: true, bank_name: 'State Bank of India', bank_code: body.bank_code, account_type: body.account_type })]; return { status: 201, body: banks[0] } },
    }))
    renderApp('/banks')
    await user.click(await screen.findByRole('button', { name: /Connect a demo bank/ }))
    await user.click(await screen.findByRole('button', { name: /State Bank of India/ }))
    expect(screen.getByText('Simulated connection')).toBeInTheDocument()
    expect(screen.getAllByText(DISCLAIMER).length).toBeGreaterThan(0)
    // nothing that looks like a bank sign-in
    expect(screen.queryByLabelText(/password|pin|otp|card|account number|user ?id|customer id/i)).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"], input[type="text"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create demo connection' })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: 'Savings account' }))
    await user.click(screen.getByRole('button', { name: 'Create demo connection' }))
    expect(api.callsTo('POST /banks')[0].body).toEqual({ bank_code: 'sbi', account_type: 'SAVINGS' })
    expect(await screen.findByRole('list', { name: 'Connected bank accounts' })).toHaveTextContent('State Bank of India')
  })

  it('changes the default and disconnects after asking', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi(routes({
      'POST /banks/bk_2/default': { body: conn('bk_2', 'ICICI', { is_default: true }) },
      'DELETE /banks/bk_2': { body: { connection_id: 'bk_2', status: 'DISCONNECTED' } },
    }))
    renderApp('/banks')
    await user.click(await screen.findByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(api.callsTo('POST /banks/bk_2/default')).toHaveLength(1))
    const rows = await screen.findAllByRole('listitem')
    await user.click(within(rows[1]).getByRole('button', { name: 'Disconnect' }))
    const ask = await screen.findByRole('alertdialog')
    expect(api.callsTo('DELETE /banks/bk_2')).toHaveLength(0) // asks first
    await user.click(within(ask).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(api.callsTo('DELETE /banks/bk_2')).toHaveLength(1))
  })

  it('shows an empty state with the way to connect when there is none', async () => {
    storeSession('customer')
    mockApi(routes({ 'GET /banks': { body: [] } }))
    renderApp('/banks')
    expect(await screen.findByText('No bank connected yet')).toBeInTheDocument()
  })

  it('is not available to a merchant', async () => {
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/banks')
    expect(screen.queryByText('Connected bank accounts')).not.toBeInTheDocument()
  })
})

describe('pay a merchant', () => {
  it('labels the nearby list as a simulation and opens the chosen request', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /payments/nearby': { body: [{ session_id: 'ps_near1', merchant_name: 'SuperGrocery', amount: '499.00', currency: 'INR', order_reference: 'SG-1', description: null, expires_at: inSeconds(600), checkout_path: '/checkout/ps_near1' }] },
      'GET /payments/sessions/ps_near1': { status: 404, body: { detail: { code: 'SESSION_NOT_FOUND', message: 'x' } } },
    })
    renderApp('/pay')
    expect(await screen.findByText(/Simulated discovery/)).toBeInTheDocument()
    expect(screen.getByText(/does not use your location/)).toBeInTheDocument()
    const link = await screen.findByRole('link', { name: /SuperGrocery/ })
    expect(link).toHaveAttribute('href', '/checkout/ps_near1')
    expect(link).toHaveTextContent('₹499.00')
    await user.click(link)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('shows an empty state when no merchant displays a request', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/nearby': { body: [] } })
    renderApp('/pay')
    expect(await screen.findByText('Nothing to show right now')).toBeInTheDocument()
  })
})

describe('checkout funding source', () => {
  const SID = 'ps_fs1'
  const A = { connection_id: 'bk_a', bank_code: 'hdfc', bank_name: 'HDFC Bank', account_type_label: 'Savings account', account_ref: 'DEMO-••••-4821', is_default: true }
  const B = { connection_id: 'bk_b', bank_code: 'icici', bank_name: 'ICICI Bank', account_type_label: 'Current account', account_ref: 'DEMO-••••-1190', is_default: false }
  const session = (sources) => ({
    session_id: SID, kind: 'MERCHANT', merchant_name: 'SuperGrocery', order_reference: 'SG-1', description: 'Groceries', amount: '499.00', currency: 'INR', status: 'CREATED',
    expires_at: inSeconds(900), max_auth_attempts: 5, attempts_remaining: 5, authorization_seconds: 120, fee: '0.00', total: '499.00', funding_sources: sources,
  })
  const challenge = { challenge_id: 'c'.repeat(43), challenge: 'turn_right', instruction: 'Slowly turn your head to your right', expires_in_seconds: 60, baseline_frames: 2, min_frames: 5, max_frames: 10 }
  const ok = {
    result: 'AUTHENTICATED', reason: null, detail: null, authentication_id: 7, liveness: 'PASSED', challenge: 'turn_right', model_version: 'v1',
    stages: [{ stage: 'FACE_DETECTION', status: 'PASSED' }, { stage: 'LIVENESS', status: 'PASSED' }, { stage: 'IDENTITY', status: 'PASSED' }],
    identity: { verified: true, frames_evaluated: 2, name: 'Asha Rao' }, session_status: 'AUTHENTICATED', attempts_remaining: 5,
    authorization: { authorization_token: 'T'.repeat(43), expires_in_seconds: 120, expires_at: inSeconds(120), step_up_required: false, step_up_reasons: [], pin_set: false },
  }
  const receipt = { transaction_id: 'FP-FUNDING001', status: 'SUCCESS', amount: '499.00', currency: 'INR', payment_method: 'FACE_PAY', timestamp: '2026-10-07T12:30:00Z', payer_name: 'Asha Rao', merchant_name: 'SuperGrocery', order_reference: 'SG-1', description: null, session_id: SID, authentication: 'Face + basic liveness check', funding_source: { bank_name: 'ICICI Bank', account_ref: 'DEMO-••••-1190' } }

  beforeEach(() => {
    Object.assign(TIMING, { baselineGapMs: 1, turnGapMs: 1, turnFrames: 6, requestTimeoutMs: 2000 })
    POLL.intervalMs = 20
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) }, configurable: true })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { value: 480, configurable: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,RlJBTUU=')
    storeSession('customer')
  })
  afterEach(() => {
    Object.assign(TIMING, ORIGINAL.timing)
    Object.assign(POLL, ORIGINAL.poll)
    delete navigator.mediaDevices
  })

  async function reachConfirmation(sources, extra = {}) {
    const user = userEvent.setup()
    const api = mockApi({
      'GET /users/me': { body: customerProfile },
      [`GET /payments/sessions/${SID}`]: { body: session(sources) },
      [`POST /payments/sessions/${SID}/authenticate/start`]: { body: challenge },
      [`POST /payments/sessions/${SID}/authenticate`]: { body: ok },
      [`POST /payments/sessions/${SID}/confirm`]: { body: receipt },
      ...extra,
    })
    renderApp(`/checkout/${SID}`)
    await user.click(await screen.findByRole('button', { name: 'Pay with Face' }))
    await user.click(await screen.findByRole('button', { name: 'Turn camera on' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start face check' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start face check' }))
    await screen.findByRole('heading', { name: 'Confirm payment' })
    return { user, api }
  }

  it('does not pay after recognition: nothing is confirmed until the explicit button is pressed', async () => {
    const { api } = await reachConfirmation([A, B])
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Confirm and Pay ₹499.00' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('preselects the default account, lets the customer change it, and confirms with the chosen one', async () => {
    const { user, api } = await reachConfirmation([A, B])
    const group = screen.getByRole('group', { name: 'Pay from' })
    expect(within(group).getByRole('radio', { name: /HDFC Bank/ })).toBeChecked()
    await user.click(within(group).getByRole('radio', { name: /ICICI Bank/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm and Pay ₹499.00' }))
    expect(await screen.findByRole('heading', { name: 'Payment successful' })).toBeInTheDocument()
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)[0].body.funding_source_id).toBe('bk_b')
    expect(screen.getByText(/Paid from ICICI Bank/)).toBeInTheDocument() // from the server's receipt
  })

  it('blocks confirmation and points to the banks page when no demo bank is connected', async () => {
    const { api } = await reachConfirmation([])
    expect(screen.getByRole('button', { name: 'Confirm and Pay ₹499.00' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Connect a demo bank' })).toHaveAttribute('href', '/banks')
    expect(api.callsTo(`POST /payments/sessions/${SID}/confirm`)).toHaveLength(0)
  })

  it('warns before the face check when no bank is connected', async () => {
    mockApi({ 'GET /users/me': { body: customerProfile }, [`GET /payments/sessions/${SID}`]: { body: session([]) } })
    renderApp(`/checkout/${SID}`)
    expect(await screen.findByText('You have no demo bank account connected')).toBeInTheDocument()
  })
})

describe('merchant face-first tools', () => {
  const SID = 'ps_m1'
  const body = (over = {}) => ({ session_id: SID, amount: '950.00', currency: 'INR', order_reference: 'SG-10492', description: null, status: 'CREATED', created_at: '2026-10-07T12:00:00Z', expires_at: inSeconds(900), checkout_path: `/checkout/${SID}`, transaction_id: null, discoverable: false, paid_at: null, ...over })
  const base = () => ({
    'GET /merchants/me': { body: merchantProfile },
    'GET /merchant/summary': { body: { currency: 'INR', total_revenue: '0', successful_payments: 0, failed_payments: 0, open_sessions: 0, revenue_by_day: [] } },
    'GET /merchant/security-summary': { status: 500, body: {} },
    'GET /merchant/payment-sessions': { body: [] },
    'GET /merchant/transactions': { body: [] },
  })

  it('creates a request that is shown in the nearby demo only when the merchant ticks the box', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    const api = mockApi({ ...base(), 'POST /merchant/payment-sessions': { status: 201, body: body({ discoverable: true }) }, [`GET /merchant/payment-sessions/${SID}`]: { body: body({ discoverable: true }) } })
    renderApp('/merchant/payments/new')
    await user.type(await screen.findByLabelText('Amount (₹)'), '950')
    await user.type(screen.getByLabelText('Order / reference'), 'SG-10492')
    await user.click(screen.getByRole('checkbox', { name: /Show in FacePay nearby/ }))
    await user.click(screen.getByRole('button', { name: 'Create payment request' }))
    expect(await screen.findByRole('region', { name: 'Session details' })).toBeInTheDocument()
    expect(api.callsTo('POST /merchant/payment-sessions')[0].body).toEqual({ amount: '950', order_reference: 'SG-10492', expires_in_minutes: 15, discoverable: true })
  })

  it('hides a displayed request again from the status page', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    const api = mockApi({ ...base(), [`GET /merchant/payment-sessions/${SID}`]: { body: body({ discoverable: true }) }, [`POST /merchant/payment-sessions/${SID}/display`]: { body: body({ discoverable: false }) } })
    renderApp(`/merchant/payments/${SID}`)
    const box = await screen.findByRole('checkbox', { name: /Show in FacePay nearby/ })
    expect(box).toBeChecked()
    await user.click(box)
    await waitFor(() => expect(api.callsTo(`POST /merchant/payment-sessions/${SID}/display`)[0].body).toEqual({ discoverable: false }))
  })

  it('never shows Paid until the backend reports a transaction for the request', async () => {
    storeSession('merchant')
    mockApi({ ...base(), [`GET /merchant/payment-sessions/${SID}`]: { body: body({ status: 'PAID', transaction_id: null }) } })
    renderApp(`/merchant/payments/${SID}`)
    const region = await screen.findByRole('region', { name: 'Session details' })
    expect(within(region).queryByText('Paid')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View transaction' })).not.toBeInTheDocument()
  })

  it('shows the paid time and the transaction once the backend confirms', async () => {
    storeSession('merchant')
    mockApi({ ...base(), [`GET /merchant/payment-sessions/${SID}`]: { body: body({ status: 'PAID', transaction_id: 'FP-AAAAAAAAAA', paid_at: '2026-10-07T12:05:00Z' }) } })
    renderApp(`/merchant/payments/${SID}`)
    expect(await screen.findByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/merchant/receipts/FP-AAAAAAAAAA')
    expect(within(screen.getByRole('region', { name: 'Session details' })).getByText('Paid')).toBeInTheDocument()
  })

  it('reconciles requests against confirmed transactions on the dashboard', async () => {
    storeSession('merchant')
    mockApi({
      ...base(),
      'GET /merchant/reconciliation': { body: { currency: 'INR', requested_total: '1450.00', paid_total: '950.00', awaiting_total: '500.00', mismatches: 0, rows: [
        { session_id: SID, order_reference: 'SG-10492', amount: '950.00', status: 'PAID', transaction_id: 'FP-AAAAAAAAAA', paid_at: '2026-10-07T12:05:00Z', created_at: '2026-10-07T12:00:00Z' },
        { session_id: 'ps_m2', order_reference: 'SG-10493', amount: '500.00', status: 'CREATED', transaction_id: null, paid_at: null, created_at: '2026-10-07T12:10:00Z' },
      ] } },
    })
    renderApp('/merchant/dashboard')
    const card = await screen.findByRole('region', { name: 'Order reconciliation' })
    expect(await within(card).findByText('₹950.00', { selector: 'dd' })).toBeInTheDocument()
    expect(within(card).getByText('Mismatches')).toBeInTheDocument()
    expect(within(card).getByRole('list', { name: 'Order reconciliation rows' })).toHaveTextContent('SG-10493')
  })
})
