import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession, tokenResponse } from '../test/helpers'

const heading = (name) => screen.findByRole('heading', { name })
const session = () => window.localStorage.getItem('facepay.session')

describe('route protection', () => {
  it('sends anonymous visitors of customer pages to customer sign in', async () => {
    mockApi({})
    renderApp('/dashboard')
    expect(await heading('Customer sign in')).toBeInTheDocument()
  })

  it('sends anonymous visitors of merchant pages to merchant sign in', async () => {
    mockApi({})
    renderApp('/merchant/dashboard')
    expect(await heading('Merchant sign in')).toBeInTheDocument()
  })

  it('returns to the originally requested page after login', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/login': { body: tokenResponse('customer') },
      'GET /users/me': { body: customerProfile },
    })
    renderApp('/profile')
    await heading('Customer sign in')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('Profile')).toBeInTheDocument()
  })

  it('restores a stored customer session and sends the bearer token', async () => {
    storeSession('customer')
    const api = mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/dashboard')
    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
    expect(api.callsTo('GET /users/me')[0].headers.Authorization).toBe('Bearer token-for-customer')
  })

  it('shows a loading indicator while a stored session is being checked', async () => {
    storeSession('customer')
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderApp('/dashboard')
    expect(screen.getByRole('status', { name: 'Loading your session' })).toBeInTheDocument()
  })

  it('keeps a customer out of merchant pages', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/merchant/dashboard')
    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
  })

  it('keeps a merchant out of customer pages', async () => {
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/dashboard')
    expect(await heading('SuperGrocery')).toBeInTheDocument()
  })

  it('clears the session when the stored token is rejected', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { status: 401, body: { detail: 'Not authenticated' } } })
    renderApp('/dashboard')
    expect(await heading('Customer sign in')).toBeInTheDocument()
    expect(session()).toBeNull()
  })

  it('ignores an expired stored session without calling the server', async () => {
    storeSession('customer', { expiresInMs: -1000 })
    const api = mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/dashboard')
    expect(await heading('Customer sign in')).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('redirects signed-in users away from the login page', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/login')
    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
  })

  it('shows a not-found page for unknown routes', async () => {
    mockApi({})
    renderApp('/nope')
    expect(await heading('Page not found')).toBeInTheDocument()
  })
})

describe('login', () => {
  it('blocks submit and shows errors for empty fields', async () => {
    const user = userEvent.setup()
    const api = mockApi({})
    renderApp('/login')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(screen.getByText('Password is required')).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('logs a customer in, loads the profile and stores the session', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'POST /auth/login': { body: tokenResponse('customer') },
      'GET /users/me': { body: customerProfile },
    })
    renderApp('/login')
    await user.type(screen.getByLabelText('Email'), ' asha@example.com ')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/login')[0].body).toEqual({ email: 'asha@example.com', password: 'Correct-horse-42' })
    expect(JSON.parse(session())).toMatchObject({ token: 'token-for-customer', role: 'customer' })
  })

  it('logs a merchant in through the merchant endpoint', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'POST /auth/merchant/login': { body: tokenResponse('merchant') },
      'GET /merchants/me': { body: merchantProfile },
    })
    renderApp('/merchant/login')
    await user.type(screen.getByLabelText('Email'), 'ravi@shop.example')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('SuperGrocery')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/login')).toHaveLength(0)
  })

  it('shows the server message on wrong credentials and stays usable', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /auth/login': { status: 401, body: { detail: 'Incorrect email or password' } } })
    renderApp('/login')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(session()).toBeNull()
  })

  it('shows the rate-limit message', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /auth/login': { status: 429, body: { detail: 'Too many attempts. Please wait a minute and try again.' } } })
    renderApp('/login')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
  })

  it('shows a friendly message when the server is unreachable', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    renderApp('/login')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server')
  })

  it('does not keep a session if loading the profile fails after login', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/login': { body: tokenResponse('customer') },
      'GET /users/me': { status: 500, body: { detail: 'boom' } },
    })
    renderApp('/login')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(session()).toBeNull()
  })
})

describe('registration', () => {
  const fillCustomer = async (user, { password = 'Correct-horse-42', confirm = password } = {}) => {
    await user.type(screen.getByLabelText('Full name'), 'Asha Rao')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), password)
    await user.type(screen.getByLabelText('Confirm password'), confirm)
  }

  it('blocks mismatched passwords', async () => {
    const user = userEvent.setup()
    const api = mockApi({})
    renderApp('/register')
    await fillCustomer(user, { confirm: 'Different-pass-9' })
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('blocks weak passwords and bad phone numbers', async () => {
    const user = userEvent.setup()
    const api = mockApi({})
    renderApp('/register')
    await fillCustomer(user, { password: 'weak' })
    await user.type(screen.getByLabelText('Phone (optional)'), 'abc')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/at least 8 characters$/)).toBeInTheDocument()
    expect(screen.getByText(/Phone must be 7 to 15 digits/)).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('registers a customer, signs them in and opens the dashboard', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'POST /auth/register': { status: 201, body: customerProfile },
      'POST /auth/login': { body: tokenResponse('customer') },
      'GET /users/me': { body: customerProfile },
    })
    renderApp('/register')
    await fillCustomer(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/register')[0].body).toEqual({
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: null,
      password: 'Correct-horse-42',
    })
  })

  it('registers a merchant with a business name and no phone field', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'POST /auth/merchant/register': { status: 201, body: merchantProfile },
      'POST /auth/merchant/login': { body: tokenResponse('merchant') },
      'GET /merchants/me': { body: merchantProfile },
    })
    renderApp('/merchant/register')
    expect(screen.queryByLabelText('Phone (optional)')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Full name'), 'Ravi Shah')
    await user.type(screen.getByLabelText('Business name'), 'SuperGrocery')
    await user.type(screen.getByLabelText('Email'), 'ravi@shop.example')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.type(screen.getByLabelText('Confirm password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await heading('SuperGrocery')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/merchant/register')[0].body).toEqual({
      name: 'Ravi Shah',
      business_name: 'SuperGrocery',
      email: 'ravi@shop.example',
      password: 'Correct-horse-42',
    })
  })

  it('shows a duplicate-email conflict from the server', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /auth/register': { status: 409, body: { detail: 'An account with this email already exists' } } })
    renderApp('/register')
    await fillCustomer(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(session()).toBeNull()
  })

  it('maps server validation errors onto the right fields', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/register': {
        status: 422,
        body: { detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email address' }] },
      },
    })
    renderApp('/register')
    await fillCustomer(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('value is not a valid email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Please fix the highlighted fields.')
  })
})

describe('logout', () => {
  it('ends a customer session and protects the pages again', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/dashboard')
    await heading('Welcome, Asha Rao')
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await heading('Customer sign in')).toBeInTheDocument()
    expect(session()).toBeNull()
  })

  it('sends a merchant back to merchant sign in', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/merchant/dashboard')
    await heading('SuperGrocery')
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await heading('Merchant sign in')).toBeInTheDocument()
    expect(session()).toBeNull()
  })
})

describe('profile', () => {
  it('shows a read-only email and saves customer changes with the bearer token', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({
      'GET /users/me': { body: customerProfile },
      'PATCH /users/me': ({ body }) => ({ body: { ...customerProfile, ...body } }),
    })
    renderApp('/profile')
    await heading('Profile')
    expect(screen.getByLabelText('Email')).toBeDisabled()

    const name = screen.getByLabelText('Full name')
    await user.clear(name)
    await user.type(name, 'Asha R')
    await user.type(screen.getByLabelText('Phone'), '9876500000')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Profile updated.')).toBeInTheDocument()
    const patch = api.callsTo('PATCH /users/me')[0]
    expect(patch.body).toEqual({ name: 'Asha R', phone: '9876500000' })
    expect(patch.headers.Authorization).toBe('Bearer token-for-customer')
  })

  it('saves merchant changes through the merchant endpoint', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    const api = mockApi({
      'GET /merchants/me': { body: merchantProfile },
      'PATCH /merchants/me': ({ body }) => ({ body: { ...merchantProfile, ...body } }),
    })
    renderApp('/merchant/profile')
    await heading('Profile')
    const business = screen.getByLabelText('Business name')
    await user.clear(business)
    await user.type(business, 'MegaGrocery')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument()
    expect(api.callsTo('PATCH /merchants/me')[0].body).toEqual({ name: 'Ravi Shah', business_name: 'MegaGrocery' })
  })

  it('validates before sending and shows server errors', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({
      'GET /users/me': { body: customerProfile },
      'PATCH /users/me': { status: 500, body: { detail: 'Something went wrong' } },
    })
    renderApp('/profile')
    await heading('Profile')
    await user.clear(screen.getByLabelText('Full name'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Name is required')).toBeInTheDocument()
    expect(api.callsTo('PATCH /users/me')).toHaveLength(0)

    await user.type(screen.getByLabelText('Full name'), 'Asha')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'))
  })
})
