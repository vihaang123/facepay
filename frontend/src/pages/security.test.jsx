import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { customerProfile, mockApi, renderApp, storeSession } from '../test/helpers'

const overview = (over = {}) => ({
  biometric_enabled: true, face_enrolled: true, samples_stored: 15,
  last_successful_authentication: '2026-10-07T12:30:00Z', biometric_locked_seconds: 0, pin_set: false, pin_locked_seconds: 0,
  recent_attempts: [
    { timestamp: '2026-10-07T12:30:00Z', result: 'SUCCESS', category: null, payment_session_ref: 'ps_1', transaction_ref: 'FP-AAAA111111' },
    { timestamp: '2026-10-07T12:20:00Z', result: 'FAILED', category: 'Liveness check', payment_session_ref: 'ps_0', transaction_ref: null },
  ],
  recent_transactions: [{ transaction_id: 'FP-AAAA111111', merchant_name: 'SuperGrocery', amount: '950.00', timestamp: '2026-10-07T12:30:00Z' }],
  recent_events: [{ kind: 'PIN_SET', timestamp: '2026-10-06T09:00:00Z', session_ref: null }, { kind: 'PAYMENT_CONFIRMED', timestamp: '2026-10-07T12:30:00Z', session_ref: 'ps_1' }],
  limits: { currency: 'INR', per_transaction: '50000.00', daily: '100000.00', spent_last_24h: '950.00', step_up_amount: '10000.00', authorization_seconds: 120 },
  risk_label: 'Risk-based authorization prototype',
  ...over,
})

beforeEach(() => storeSession('customer'))

const base = (extra = {}) => ({ 'GET /users/me': { body: customerProfile }, 'GET /security/overview': { body: overview() }, ...extra })

describe('customer security page', () => {
  it('is linked from the desktop navigation and from Profile', async () => {
    mockApi(base())
    const { unmount } = renderApp('/profile')
    expect((await screen.findAllByRole('link', { name: 'Security' }))[0]).toHaveAttribute('href', '/security')
    unmount()
  })

  it('shows what is switched on, the last success, recent attempts and payments', async () => {
    mockApi(base())
    renderApp('/security')
    await screen.findByRole('heading', { name: 'Security' })
    expect(screen.getByRole('switch', { name: 'Face authentication for payments' })).toBeChecked()
    expect(screen.getByText('Complete')).toBeInTheDocument()
    const attempts = screen.getByRole('heading', { name: 'Recent face checks' }).closest('section')
    expect(within(attempts).getByText('Successful')).toBeInTheDocument()
    expect(within(attempts).getByText('Unsuccessful').closest('li')).toHaveTextContent('Liveness check')
    const payments = screen.getByRole('heading', { name: 'Recent payments' }).closest('section')
    expect(within(payments).getByRole('link', { name: 'SuperGrocery' })).toHaveAttribute('href', '/receipts/FP-AAAA111111')
    expect(screen.getByText('Payment PIN set')).toBeInTheDocument()
    expect(screen.getByText(/Risk-based authorization prototype/)).toBeInTheDocument()
  })

  it('never shows raw images, vectors or scores', async () => {
    mockApi(base())
    renderApp('/security')
    await screen.findByRole('heading', { name: 'Security' })
    expect(document.querySelectorAll('img, canvas')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/confidence|distance|vector|embedding/i)
  })

  it('switches face payments off and on again through the server', async () => {
    const user = userEvent.setup()
    let enabled = true
    const api = mockApi(base({
      'GET /security/overview': () => ({ body: overview({ biometric_enabled: enabled }) }),
      'PUT /security/biometric': ({ body }) => { enabled = body.enabled; return { body: overview({ biometric_enabled: enabled }) } },
    }))
    renderApp('/security')
    const toggle = await screen.findByRole('switch', { name: 'Face authentication for payments' })
    await user.click(toggle)
    expect(await screen.findByText('Face payments are off.')).toBeInTheDocument()
    expect(api.callsTo('PUT /security/biometric')[0].body).toEqual({ enabled: false })
    expect(screen.getByRole('switch', { name: 'Face authentication for payments' })).not.toBeChecked()
    expect(screen.getByText(/will not use your face to authorize payments/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Face authentication for payments' }))
    expect(await screen.findByText('Face payments are on.')).toBeInTheDocument()
    expect(api.callsTo('PUT /security/biometric')[1].body).toEqual({ enabled: true })
  })

  it('shows the lockout in plain words', async () => {
    mockApi(base({ 'GET /security/overview': { body: overview({ biometric_locked_seconds: 600 }) } }))
    renderApp('/security')
    expect(await screen.findByText(/Too many unsuccessful attempts. Please try again in about 10 minutes or use another verification method./)).toBeInTheDocument()
  })

  it('sets a payment PIN with the account password, digits only', async () => {
    const user = userEvent.setup()
    const api = mockApi(base({ 'PUT /security/pin': { body: overview({ pin_set: true }) } }))
    renderApp('/security')
    await user.click(await screen.findByRole('button', { name: 'Set a PIN' }))
    const save = screen.getByRole('button', { name: 'Save PIN' })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Your account password'), 'S3cret-pass')
    await user.type(screen.getByLabelText('New 6-digit PIN'), '12ab3456789')
    expect(screen.getByLabelText('New 6-digit PIN')).toHaveValue('123456')
    await user.click(save)
    expect(await screen.findByText('Payment PIN saved.')).toBeInTheDocument()
    expect(api.callsTo('PUT /security/pin')[0].body).toEqual({ password: 'S3cret-pass', new_pin: '123456' })
  })

  it('shows the server’s reason when the password is wrong', async () => {
    const user = userEvent.setup()
    mockApi(base({ 'PUT /security/pin': { status: 403, body: { detail: { code: 'PASSWORD_INCORRECT', message: 'That password is not correct.' } } } }))
    renderApp('/security')
    await user.click(await screen.findByRole('button', { name: 'Set a PIN' }))
    await user.type(screen.getByLabelText('Your account password'), 'nope')
    await user.type(screen.getByLabelText('New 6-digit PIN'), '123456')
    await user.click(screen.getByRole('button', { name: 'Save PIN' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.')
  })

  it('removes a PIN after the password is confirmed', async () => {
    const user = userEvent.setup()
    const api = mockApi(base({
      'GET /security/overview': { body: overview({ pin_set: true }) },
      'POST /security/pin/remove': { body: overview({ pin_set: false }) },
    }))
    renderApp('/security')
    await user.click(await screen.findByRole('button', { name: 'Remove PIN' }))
    await user.type(screen.getByLabelText('Your account password'), 'S3cret-pass')
    await user.click(screen.getByRole('button', { name: 'Remove PIN', exact: true, hidden: false }))
    expect(await screen.findByText('Payment PIN removed.')).toBeInTheDocument()
    expect(api.callsTo('POST /security/pin/remove')[0].body).toEqual({ password: 'S3cret-pass' })
  })

  it('removes face data only after a confirmation, and offers to re-enroll', async () => {
    const user = userEvent.setup()
    const api = mockApi(base({ 'DELETE /faces/samples': { status: 204, body: null } }))
    renderApp('/security')
    expect(await screen.findByRole('link', { name: 'Re-enroll my face' })).toHaveAttribute('href', '/face')
    await user.click(screen.getByRole('button', { name: 'Remove my face data' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/not be able to pay with your face/)
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Remove face data' }))
    expect(await screen.findByText(/Your face data was removed/)).toBeInTheDocument()
    expect(api.callsTo('DELETE /faces/samples')).toHaveLength(1)
  })

  it('shows an error with a retry when the overview cannot load', async () => {
    mockApi(base({ 'GET /security/overview': { status: 500, body: { detail: 'boom' } } }))
    renderApp('/security')
    expect(await screen.findByRole('alert')).toHaveTextContent(/went wrong on our side/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('is not available to merchants', async () => {
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: { id: 1, name: 'R', email: 'r@x.test', business_name: 'B', created_at: '2026-10-07T10:00:00Z' } } })
    renderApp('/security')
    expect(screen.queryByRole('heading', { name: 'Security' })).not.toBeInTheDocument()
  })
})
