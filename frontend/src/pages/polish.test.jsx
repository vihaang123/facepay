import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from '../components/ErrorBoundary'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession } from '../test/helpers'
import { faceStatus } from '../utils/faceStatus'
import Home from './Home'

afterEach(() => vi.restoreAllMocks())
beforeEach(() => window.localStorage.clear())

const tx = (n, over = {}) => ({
  transaction_id: `FP-${String(n).padStart(10, 'A')}`, status: 'SUCCESS', amount: `${n}00.00`, currency: 'INR', payment_method: 'FACE_PAY',
  timestamp: '2026-10-07T12:30:00Z', merchant_name: 'SuperGrocery', payer_name: 'Asha Rao', order_reference: `SG-${n}`, session_id: null, ...over,
})
const act = (n, over = {}) => ({
  ref: `FP-${String(n).padStart(10, 'A')}`, kind: 'TRANSFER', direction: 'SENT', status: 'SUCCESS', counterparty_name: 'Ravi Shah', counterparty_masked_id: 'ra***i@facepay',
  amount: `${n}00.00`, currency: 'INR', timestamp: '2026-10-07T12:30:00Z', note: `Note ${n}`, order_reference: null, ...over,
})
const homeRoutes = (over = {}) => ({
  'GET /users/me': { body: { ...customerProfile, facepay_id: 'asha.rao@facepay' } },
  'GET /wallet': { body: { balance: '9500.00', currency: 'INR', simulated: true, entries: [] } },
  'GET /activity': { body: [] },
  'GET /activity/counts': { body: { pending_incoming_requests: 0 } },
  'GET /faces/enrollment': { body: { total_samples: 14, distinct_poses: 4, min_samples_to_train: 12, min_poses_to_train: 3, max_samples: 40, eligible: true, poses: [] } },
  'GET /faces/model': { body: { model: { version: 'v1', trained_at: '2026-10-07T10:00:00Z', includes_you: true, stale: false } } },
  'GET /face-auth/attempts': { body: [] },
  ...over,
})
const url = (api, key) => new URL(api.mock.calls.filter(([u, i]) => `${(i?.method || 'GET')} ${new URL(u).pathname}` === key).at(-1)[0])

describe('landing page', () => {
  const html = async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', database: 'ok' }) }))
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    await screen.findAllByText('Connected')
    return container.textContent
  }

  it('explains the product and says plainly that it is a simulation', async () => {
    const text = await html()
    expect(text).toContain('FacePay uses facial authentication to authorize simulated digital payments.')
    expect(text).toContain('Prototype / Academic Project')
    expect(text).toMatch(/no real money moves/i)
  })

  it('makes none of the claims the project must not make', async () => {
    const text = (await html()).toLowerCase()
    for (const banned of ['bank-grade', 'military-grade', 'fraud-proof', 'unhackable', '100% secure', 'replaces upi', 'production-ready']) {
      expect(text).not.toContain(banned)
    }
    // the only mentions of banks/UPI are denials
    expect(text).toMatch(/not connected to any bank/)
    expect(screen.getAllByRole('link', { name: 'Try FacePay' })[0]).toHaveAttribute('href', '/register')
  })
})

describe('navigation', () => {
  it('has a bottom navigation on phones instead of a hamburger menu', async () => {
    mockApi(homeRoutes())
    storeSession('customer')
    renderApp('/dashboard')
    const mobile = await screen.findByRole('navigation', { name: 'Mobile' })
    expect(within(mobile).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Send', 'Scan', 'Activity', 'Profile'])
    expect(within(mobile).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument()
  })

  it('offers a skip link and role-specific navigation', async () => {
    mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /merchant/summary': { status: 500, body: {} }, 'GET /merchant/payment-sessions': { body: [] }, 'GET /merchant/transactions': { body: [] } })
    storeSession('merchant')
    renderApp('/merchant/dashboard')
    expect(await screen.findByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'New payment', 'Transactions', 'Profile'])
  })
})

describe('transactions page', () => {
  it('customer: lists own activity, filters, searches and loads more through the API', async () => {
    const user = userEvent.setup()
    const page = Array.from({ length: 21 }, (_, i) => act(i + 1)) // 21 = one more than a page: there is more to load
    const api = mockApi(homeRoutes({ 'GET /activity': () => ({ body: page }) }))
    storeSession('customer')
    renderApp('/activity')
    const list = await screen.findByRole('list', { name: 'Activity' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(20) // the 21st row only signals more
    expect(url(api, 'GET /activity').searchParams.get('limit')).toBe('21')

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(url(api, 'GET /activity').searchParams.get('offset')).toBe('20'))

    await user.click(screen.getByRole('button', { name: 'Failed' }))
    await waitFor(() => expect(url(api, 'GET /activity').searchParams.get('filter')).toBe('failed'))
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true')
    await user.type(screen.getByLabelText('Search activity'), 'Cab')
    await waitFor(() => expect(url(api, 'GET /activity').searchParams.get('q')).toBe('Cab'))
  })

  it('merchant: uses the merchant endpoint and shows the customer', async () => {
    storeSession('merchant')
    const api = mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /merchant/transactions': { body: [tx(1)] } })
    renderApp('/merchant/transactions')
    const table = await screen.findByRole('list', { name: 'Transactions' })
    expect(within(table).getByText('Asha Rao')).toBeInTheDocument()
    expect(within(table).getByRole('link')).toHaveAttribute('href', '/merchant/receipts/FP-AAAAAAAAA1')
    expect(api.calls.some((c) => c.key === 'GET /payments/transactions')).toBe(false)
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument() // one page only
  })

  it('distinguishes "no activity yet" from "nothing matches"', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi(homeRoutes())
    renderApp('/activity')
    expect(await screen.findByText('No activity yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sent' }))
    expect(await screen.findByText('Nothing matches')).toBeInTheDocument()
  })

  it('shows a friendly error with a working retry', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let fail = true
    mockApi(homeRoutes({ 'GET /activity': () => (fail ? { status: 503, body: { detail: 'upstream connect error' } } : { body: [act(1)] }) }))
    renderApp('/activity')
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
    expect(screen.queryByText(/upstream/)).not.toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Activity' })).toBeInTheDocument()
  })

  it('the old customer transactions address leads to activity', async () => {
    storeSession('customer')
    mockApi(homeRoutes())
    renderApp('/transactions')
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument()
  })
})

describe('customer dashboard', () => {
  const enrollment = (over = {}) => ({ total_samples: 0, distinct_poses: 0, min_samples_to_train: 12, min_poses_to_train: 3, max_samples: 40, eligible: false, poses: [], ...over })

  it.each([
    [enrollment(), null, 'Not set up'],
    [enrollment({ total_samples: 5 }), null, 'More samples needed'],
    [enrollment({ total_samples: 14, eligible: true }), null, 'Training needed'],
    [enrollment({ total_samples: 14, eligible: true }), { includes_you: true, stale: false }, 'Ready'],
    [enrollment({ total_samples: 14, eligible: true }), { includes_you: true, stale: true }, 'Retrain needed'],
  ])('derives the FacePay status from enrollment and model %#', (e, model, label) => {
    expect(faceStatus(e, model).label).toBe(label)
  })

  it('shows the FacePay ID, simulated balance, actions, recent activity and security status', async () => {
    storeSession('customer')
    mockApi(homeRoutes({ 'GET /activity': { body: [act(9, { amount: '950.00' })] }, 'GET /activity/counts': { body: { pending_incoming_requests: 2 } } }))
    renderApp('/dashboard')
    expect(await screen.findByTestId('facepay-id')).toHaveTextContent('asha.rao@facepay')
    expect(await screen.findByTestId('balance')).toHaveTextContent('₹9,500.00')
    expect(screen.getByText(/Simulated balance/)).toBeInTheDocument()
    const actions = screen.getByRole('navigation', { name: 'Money actions' })
    expect(within(actions).getAllByRole('link').map((a) => a.textContent)).toEqual(['Send money', 'Request money', 'Scan QR', 'My QR'])
    expect(await screen.findByRole('list', { name: 'Recent activity' })).toBeInTheDocument()
    expect(await screen.findByText('Face authentication ready')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Biometric settings' })).toHaveAttribute('href', '/security')
    expect(screen.getByRole('link', { name: 'Requests, 2 waiting for you' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/activity')
  })

  it('never shows model internals to a customer', async () => {
    storeSession('customer')
    mockApi(homeRoutes())
    renderApp('/dashboard')
    await screen.findByText('Face authentication ready')
    const text = document.body.textContent.toLowerCase()
    for (const banned of ['pca', 'lda', 'confusion', 'eigen', 'distance', 'confidence', 'classifier', 'explained variance']) expect(text).not.toContain(banned)
  })

  it('hides and shows the balance on request', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi(homeRoutes())
    renderApp('/dashboard')
    expect(await screen.findByTestId('balance')).toHaveTextContent('₹9,500.00')
    await user.click(screen.getByRole('button', { name: 'Hide balance' }))
    expect(screen.getByTestId('balance')).not.toHaveTextContent('9,500')
    await user.click(screen.getByRole('button', { name: 'Show balance' }))
    expect(screen.getByTestId('balance')).toHaveTextContent('₹9,500.00')
  })

  it('each section fails on its own, with a retry, and the rest still renders', async () => {
    storeSession('customer')
    mockApi(homeRoutes({ 'GET /faces/enrollment': { status: 500, body: {} } }))
    renderApp('/dashboard')
    expect(await screen.findByText('No activity yet')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByTestId('balance')).toHaveTextContent('₹9,500.00')
  })

  it('shows empty-state guidance when there is no activity', async () => {
    storeSession('customer')
    mockApi(homeRoutes())
    renderApp('/dashboard')
    expect(await screen.findByText('No activity yet')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Send money' }).length).toBeGreaterThanOrEqual(2) // the action grid and the empty state
  })
})

describe('error handling', () => {
  it.each([
    [403, undefined, /do not have access/],
    [404, undefined, /could not find/],
    [409, undefined, /no longer possible/],
    [429, undefined, /Too many requests/],
    [500, 'Traceback (most recent call last): boom', /Something went wrong on our side/],
    [502, '<html>Bad gateway</html>', /temporarily unavailable/],
    [504, undefined, /took too long/],
  ])('maps HTTP %i to a friendly message without leaking server text', async (status, detail, message) => {
    storeSession('customer')
    mockApi(homeRoutes({ 'GET /activity': { status, body: detail ? { detail } : {} } }))
    renderApp('/activity')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(message)
    expect(alert.textContent).not.toMatch(/Traceback|<html>|HTTP \d{3}|Request failed/)
  })

  it('reports an unreachable server in plain words', async () => {
    storeSession('customer')
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      if (String(u).endsWith('/users/me')) return { ok: true, status: 200, json: async () => customerProfile }
      throw new TypeError('Failed to fetch')
    }))
    renderApp('/activity')
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server')
  })

  it('times out a request that never answers', async () => {
    storeSession('customer')
    const { apiFetch } = await import('../services/api')
    vi.stubGlobal('fetch', vi.fn((u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))))
    await expect(apiFetch('/anything', { timeoutMs: 20 })).rejects.toMatchObject({ status: 0, code: 'TIMEOUT', message: expect.stringMatching(/took too long/) })
  })

  it('a rejected token logs the user out and the login page says why', async () => {
    storeSession('customer')
    mockApi(homeRoutes({ 'GET /activity': { status: 401, body: { detail: 'Token expired' } } }))
    renderApp('/activity')
    expect(await screen.findByRole('heading', { name: 'Customer sign in' })).toBeInTheDocument()
    expect(screen.getByText('Your session has expired.')).toBeInTheDocument()
    expect(window.localStorage.getItem('facepay.session')).toBeNull()
  })

  it('the error boundary replaces a crashed page with a calm message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Bomb = () => { throw new Error('secret internal detail') }
    render(<ErrorBoundary><Bomb /></ErrorBoundary>)
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.queryByText(/secret internal detail/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to FacePay' })).toHaveAttribute('href', '/')
  })
})

describe('receipts', () => {
  it('offers print, and shows the transaction, amount and method', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    storeSession('customer')
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /payments/transactions/FP-AAAAAAAAA1': { body: { ...tx(1, { amount: '950.00' }), payer_name: 'Asha Rao', description: null } },
    })
    renderApp('/receipts/FP-AAAAAAAAA1')
    const receipt = await screen.findByRole('article', { name: 'Payment receipt' })
    expect(within(receipt).getByText('₹950.00')).toBeInTheDocument()
    expect(within(receipt).getByText('FP-AAAAAAAAA1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download / Print receipt' }))
    expect(print).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Done' })).toHaveAttribute('href', '/activity')
  })
})
