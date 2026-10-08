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
    expect(text).toContain('Facial authentication for simulated digital payments.')
    expect(text).toMatch(/Academic prototype/)
    expect(text).toMatch(/no real money moves/i)
  })

  it('makes none of the claims the project must not make', async () => {
    const text = (await html()).toLowerCase()
    for (const banned of ['bank-grade', 'military-grade', 'fraud-proof', 'unhackable', '100% secure', 'replaces upi', 'production-ready']) {
      expect(text).not.toContain(banned)
    }
    // the only mentions of banks/UPI are denials
    expect(text).toMatch(/not connected to any bank/)
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/register')
  })
})

describe('navigation', () => {
  it('has a working mobile menu that toggles and closes on navigation', async () => {
    const user = userEvent.setup()
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { body: [] }, 'GET /payments/summary': { body: { currency: 'INR', total_spent: '0', payments: 0, spent_last_30_days: '0', last_payment_at: null } } })
    storeSession('customer')
    renderApp('/dashboard')
    const menu = await screen.findByRole('button', { name: 'Open menu' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('navigation', { name: 'Mobile' })).not.toBeInTheDocument()
    await user.click(menu)
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true')
    const mobile = screen.getByRole('navigation', { name: 'Mobile' })
    await user.click(within(mobile).getByRole('link', { name: 'Transactions' }))
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Mobile' })).not.toBeInTheDocument())
  })

  it('offers a skip link and role-specific navigation', async () => {
    mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /merchant/summary': { status: 500, body: {} }, 'GET /merchant/payment-sessions': { body: [] }, 'GET /merchant/transactions': { body: [] } })
    storeSession('merchant')
    renderApp('/merchant/dashboard')
    expect(await screen.findByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'New payment', 'Transactions', 'Profile'])
  })
})

describe('transactions page', () => {
  const rows = Array.from({ length: 11 }, (_, i) => tx(i + 1)) // 11 = one more than a page: there is a next page

  it('customer: lists own payments, filters, sorts, searches and pages through the API', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /payments/transactions': ({ headers }) => ({ body: rows, headers }),
    })
    storeSession('customer')
    renderApp('/transactions')
    const table = await screen.findByRole('table', { name: 'Transactions' })
    expect(within(table).getAllByRole('row')).toHaveLength(11) // header + 10 (the 11th only signals a next page)
    expect(within(table).getByRole('columnheader', { name: 'Merchant' })).toBeInTheDocument()
    expect(url(api, 'GET /payments/transactions').searchParams.get('limit')).toBe('11')

    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(url(api, 'GET /payments/transactions').searchParams.get('offset')).toBe('10'))
    expect(screen.getByText('Page 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(url(api, 'GET /payments/transactions').searchParams.get('offset')).toBe('0'))

    await user.selectOptions(screen.getByLabelText('Status'), 'FAILED')
    await waitFor(() => expect(url(api, 'GET /payments/transactions').searchParams.get('status')).toBe('FAILED'))
    await user.selectOptions(screen.getByLabelText('Sort by'), 'amount_desc')
    await waitFor(() => expect(url(api, 'GET /payments/transactions').searchParams.get('sort')).toBe('amount_desc'))
    await user.type(screen.getByLabelText('Search'), 'SG-4')
    await waitFor(() => expect(url(api, 'GET /payments/transactions').searchParams.get('q')).toBe('SG-4'))
  })

  it('merchant: uses the merchant endpoint and shows the customer', async () => {
    storeSession('merchant')
    const api = mockApi({ 'GET /merchants/me': { body: merchantProfile }, 'GET /merchant/transactions': { body: [tx(1)] } })
    renderApp('/merchant/transactions')
    const table = await screen.findByRole('table', { name: 'Transactions' })
    expect(within(table).getByRole('columnheader', { name: 'Customer' })).toBeInTheDocument()
    expect(within(table).getByText('Asha Rao')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'FP-AAAAAAAAA1' })).toHaveAttribute('href', '/merchant/receipts/FP-AAAAAAAAA1')
    expect(api.calls.some((c) => c.key === 'GET /payments/transactions')).toBe(false)
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument() // one page only
  })

  it('distinguishes "no transactions yet" from "nothing matches"', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { body: [] } })
    renderApp('/transactions')
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Status'), 'SUCCESS')
    expect(await screen.findByText('No transactions match')).toBeInTheDocument()
  })

  it('shows a friendly error with a working retry', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let fail = true
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': () => (fail ? { status: 503, body: { detail: 'upstream connect error' } } : { body: [tx(1)] }) })
    renderApp('/transactions')
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
    expect(screen.queryByText(/upstream/)).not.toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table', { name: 'Transactions' })).toBeInTheDocument()
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

  it('shows face status, spending summary and recent payments', async () => {
    storeSession('customer')
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /faces/enrollment': { body: enrollment({ total_samples: 14, eligible: true }) },
      'GET /faces/model': { body: { model: { includes_you: true, stale: false } } },
      'GET /payments/summary': { body: { currency: 'INR', total_spent: '1070.50', payments: 2, spent_last_30_days: '950.00', last_payment_at: '2026-10-07T12:30:00Z' } },
      'GET /payments/transactions': { body: [tx(9, { amount: '950.00' })] },
    })
    renderApp('/dashboard')
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(await screen.findByText('₹1,070.50')).toBeInTheDocument()
    expect(screen.getByText('Successful payments only')).toBeInTheDocument()
    expect(await screen.findByRole('table', { name: 'Recent payments' })).toBeInTheDocument()
  })

  it('each section fails on its own, with a retry, and the rest still renders', async () => {
    storeSession('customer')
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /faces/enrollment': { status: 500, body: {} },
      'GET /faces/model': { body: { model: null } },
      'GET /payments/summary': { body: { currency: 'INR', total_spent: '0', payments: 0, spent_last_30_days: '0', last_payment_at: null } },
      'GET /payments/transactions': { body: [] },
    })
    renderApp('/dashboard')
    expect(await screen.findByText('Open a checkout link from a merchant to pay with FacePay.')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
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
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /payments/transactions': { status, body: detail ? { detail } : {} } })
    renderApp('/transactions')
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
    renderApp('/transactions')
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
    mockApi({
      'GET /users/me': { body: customerProfile },
      'GET /payments/transactions': { status: 401, body: { detail: 'Token expired' } },
    })
    renderApp('/transactions')
    expect(await screen.findByRole('heading', { name: 'Customer sign in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended')
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
    await user.click(screen.getByRole('button', { name: 'Print receipt' }))
    expect(print).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'All transactions' })).toHaveAttribute('href', '/transactions')
  })
})
