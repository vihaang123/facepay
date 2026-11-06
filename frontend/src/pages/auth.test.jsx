import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { customerProfile, merchantProfile, mockApi, renderApp, storeSession, tokenResponse } from '../test/helpers'

const heading = (name) => screen.findByRole('heading', { name: name === 'Welcome, Asha Rao' ? /^Good (morning|afternoon|evening), Asha$/ : name })
const session = () => window.localStorage.getItem('facepay.session')

describe('route protection', () => {
  it('sends anonymous visitors of customer pages to sign in', async () => {
    mockApi({})
    renderApp('/dashboard')
    expect(await heading('Sign in')).toBeInTheDocument()
  })

  it('sends anonymous visitors of merchant pages to the same sign in', async () => {
    mockApi({})
    renderApp('/merchant/dashboard')
    expect(await heading('Sign in')).toBeInTheDocument()
  })

  it('returns to the originally requested page after login', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/number/signin': { body: tokenResponse('customer') },
      'GET /users/me': { body: customerProfile },
    })
    renderApp('/profile')
    await heading('Sign in')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.type(screen.getByLabelText('6-digit passcode'), '482915')
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
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(session()).toBeNull()
  })

  it('ignores an expired stored session without calling the server', async () => {
    storeSession('customer', { expiresInMs: -1000 })
    const api = mockApi({ 'GET /users/me': { body: customerProfile } })
    renderApp('/dashboard')
    expect(await heading('Sign in')).toBeInTheDocument()
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

describe('email sign in (older accounts)', () => {
  it('blocks submit and shows errors for empty fields', async () => {
    const user = userEvent.setup()
    const api = mockApi({})
    renderApp('/login/email')
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
    renderApp('/login/email')
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
    renderApp('/login/email')
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
    renderApp('/login/email')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
  })

  it('shows a friendly message when the server is unreachable', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    renderApp('/login/email')
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
    renderApp('/login/email')
    await user.type(screen.getByLabelText('Email'), 'asha@example.com')
    await user.type(screen.getByLabelText('Password'), 'Correct-horse-42')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(session()).toBeNull()
  })
})

describe('mobile number sign in', () => {
  const fill = async (user, mobile = '98765 43210', passcode = '482915') => {
    await user.type(screen.getByLabelText('Mobile number'), mobile)
    await user.type(screen.getByLabelText('6-digit passcode'), passcode)
  }

  it('asks for a number and a passcode before calling the server', async () => {
    const user = userEvent.setup()
    const api = mockApi({})
    renderApp('/login')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter a valid 10-digit mobile number.')).toBeInTheDocument()
    expect(screen.getByText('Enter your 6-digit passcode.')).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('signs a customer in with the number as the server wants it and opens the dashboard', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      'POST /auth/number/signin': { body: tokenResponse('customer') },
      'GET /users/me': { body: customerProfile },
    })
    renderApp('/login')
    await fill(user, '+91 98765-43210')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('Welcome, Asha Rao')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/number/signin')[0].body).toEqual({ mobile: '9876543210', passcode: '482915' })
    expect(JSON.parse(session())).toMatchObject({ token: 'token-for-customer', role: 'customer' })
  })

  it('takes a shop to its own dashboard: the server says which role the number belongs to', async () => {
    const user = userEvent.setup()
    mockApi({
      'POST /auth/number/signin': { body: tokenResponse('merchant') },
      'GET /merchants/me': { body: merchantProfile },
    })
    renderApp('/login')
    await fill(user, '9123456789')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('SuperGrocery')).toBeInTheDocument()
  })

  it('shows the server message for a wrong passcode and stays usable', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /auth/number/signin': { status: 401, body: { detail: { code: 'BAD_CREDENTIALS', message: 'Wrong mobile number or passcode.' } } } })
    renderApp('/login')
    await fill(user, '9876543210', '000001')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong mobile number or passcode.')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(session()).toBeNull()
  })

  it('says how long a locked number must wait', async () => {
    const user = userEvent.setup()
    mockApi({ 'POST /auth/number/signin': { status: 429, body: { detail: { code: 'SIGNIN_LOCKED', message: 'Too many wrong passcodes. Try again in 15 minutes.' } } } })
    renderApp('/login')
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 15 minutes')
  })

  it('keeps only digits in the passcode and masks them until asked', async () => {
    const user = userEvent.setup()
    renderApp('/login')
    const field = screen.getByLabelText('6-digit passcode')
    await user.type(field, '48a29b15')
    expect(field).toHaveValue('482915')
    expect(field).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field).toHaveAttribute('type', 'text')
  })

  it('does not promise passcode recovery and still offers the older email sign-in', async () => {
    renderApp('/login')
    expect(screen.getByText(/Passcode recovery is not available/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Older account\? Sign in with email/ })).toHaveAttribute('href', '/login/email')
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/start')
  })
})

describe('getting started with a mobile number', () => {
  const OTP = { challenge_id: 'chal-abc-123456', mobile_masked: '+91 •••••43210', expires_in: 300, resend_in: 30, demo: true, demo_code: '703518' }
  const routes = (over = {}) => ({
    'POST /auth/number/otp': { body: OTP },
    'POST /auth/number/verify': { body: { verified: true } },
    'POST /auth/number/signup': { status: 201, body: tokenResponse('customer') },
    'GET /users/me': { body: { ...customerProfile, mobile: '9876543210', email: null } },
    'GET /banks/catalog': { body: { banks: [{ code: 'hdfc', name: 'HDFC Bank', short: 'HDFC', color: '#0b3d7a' }], max_connected: 5, disclaimer: 'Demo', behaviors: [], behavior_note: '' } },
    'GET /banks': { body: [] },
    ...over,
  })

  const toDetails = async (user, mobile = '98765 43210') => {
    await user.type(screen.getByLabelText('Mobile number'), mobile)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('status', { name: 'Demo one-time code' })
    await user.type(screen.getByLabelText('6-digit code'), '703518')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    await screen.findByLabelText('Full name')
  }

  const fillDetails = async (user, { passcode = '482915', confirm = passcode, agree = true } = {}) => {
    await user.type(screen.getByLabelText('Full name'), 'Asha Rao')
    await user.type(screen.getByLabelText('Choose a 6-digit passcode'), passcode)
    await user.type(screen.getByLabelText('Confirm passcode'), confirm)
    if (agree) await user.click(screen.getByRole('checkbox', { name: /simulated prototype/i }))
  }

  it('/register now leads to the number flow', async () => {
    mockApi({})
    renderApp('/register')
    expect(await heading('Get started')).toBeInTheDocument()
    expect(screen.getByLabelText('Mobile number')).toBeInTheDocument()
  })

  it('checks the number before asking the server for a code', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes())
    renderApp('/start')
    await user.type(screen.getByLabelText('Mobile number'), '12345')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Enter a valid 10-digit mobile number.')).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('shows the code on screen and says plainly that it is a demo and sends no SMS', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes())
    renderApp('/start')
    await user.type(screen.getByLabelText('Mobile number'), '+91 98765 43210')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    const box = await screen.findByRole('status', { name: 'Demo one-time code' })
    expect(box).toHaveTextContent('703518')
    expect(box).toHaveTextContent(/no SMS is sent/)
    expect(box).toHaveTextContent(/does not prove this number is yours/)
    expect(api.callsTo('POST /auth/number/otp')[0].body).toEqual({ mobile: '9876543210', purpose: 'signup' })
    expect(screen.getByRole('button', { name: /Resend code in/ })).toBeDisabled()
  })

  it('rejects a wrong code with the server message', async () => {
    const user = userEvent.setup()
    mockApi(routes({ 'POST /auth/number/verify': { status: 400, body: { detail: { code: 'OTP_INVALID', message: 'That code is not right, or it has expired. Ask for a new code.' } } } }))
    renderApp('/start')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('status', { name: 'Demo one-time code' })
    await user.type(screen.getByLabelText('6-digit code'), '111111')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right')
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument()
  })

  it('sends a number that already has an account to sign in', async () => {
    const user = userEvent.setup()
    mockApi(routes({ 'POST /auth/number/otp': { status: 409, body: { detail: { code: 'NUMBER_REGISTERED', message: 'This number already has a FacePay account. Sign in instead.' } } } }))
    renderApp('/start')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('already has a FacePay account')
    expect(within(alert).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('lets the person change the number after the code is shown', async () => {
    const user = userEvent.setup()
    mockApi(routes())
    renderApp('/start')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('status', { name: 'Demo one-time code' })
    await user.click(screen.getByRole('button', { name: 'Change number' }))
    expect(screen.getByLabelText('Mobile number')).toBeInTheDocument()
  })

  it('creates a personal account, signs in and goes on to choose a bank', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes())
    renderApp('/start')
    await toDetails(user)
    expect(screen.getByText(/confirmed \(demo code\)/)).toBeInTheDocument()
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Which bank is your mobile number linked to?')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/number/signup')[0].body).toEqual({
      challenge_id: 'chal-abc-123456', account_type: 'customer', name: 'Asha Rao', passcode: '482915', agreed: true,
    })
    expect(JSON.parse(session())).toMatchObject({ role: 'customer' })
  })

  it('blocks a weak passcode, a mismatch and a missing agreement without calling the server', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes())
    renderApp('/start')
    await toDetails(user)
    const before = api.calls.length
    await fillDetails(user, { passcode: '123456', agree: false })
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/harder to guess/)).toBeInTheDocument()
    expect(screen.getByText('Agree to continue.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Choose a 6-digit passcode'))
    await user.type(screen.getByLabelText('Choose a 6-digit passcode'), '482915')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('The passcodes do not match.')).toBeInTheDocument()
    expect(api.calls).toHaveLength(before)
    expect(session()).toBeNull()
  })

  it('opens a shop account with a business name and goes straight to its dashboard', async () => {
    const user = userEvent.setup()
    const api = mockApi(routes({
      'POST /auth/number/signup': { status: 201, body: tokenResponse('merchant') },
      'GET /merchants/me': { body: merchantProfile },
    }))
    renderApp('/start?as=shop')
    await toDetails(user, '9123456789')
    expect(screen.getByRole('radio', { name: 'Shop account' })).toBeChecked()
    await user.type(screen.getByLabelText('Full name'), 'Ravi Shah')
    await user.type(screen.getByLabelText('Shop or business name'), 'SuperGrocery')
    await user.type(screen.getByLabelText('Choose a 6-digit passcode'), '482915')
    await user.type(screen.getByLabelText('Confirm passcode'), '482915')
    await user.click(screen.getByRole('checkbox', { name: /simulated prototype/i }))
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await heading('SuperGrocery')).toBeInTheDocument()
    expect(api.callsTo('POST /auth/number/signup')[0].body).toMatchObject({ account_type: 'merchant', business_name: 'SuperGrocery' })
  })

  it('shows a server refusal at the last step and keeps the person signed out', async () => {
    const user = userEvent.setup()
    mockApi(routes({ 'POST /auth/number/signup': { status: 409, body: { detail: { code: 'NUMBER_REGISTERED', message: 'This number already has a FacePay account. Sign in instead.' } } } }))
    renderApp('/start')
    await toDetails(user)
    await fillDetails(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a FacePay account')
    expect(session()).toBeNull()
  })
})

describe('after joining: bank, then face', () => {
  const catalog = { banks: [{ code: 'hdfc', name: 'HDFC Bank', short: 'HDFC', color: '#0b3d7a' }], max_connected: 5, disclaimer: 'Demo', behaviors: [], behavior_note: '' }
  const made = { connection_id: 'bk_1', bank_code: 'hdfc', bank_name: 'HDFC Bank', account_type: 'SAVINGS', account_type_label: 'Savings account', account_ref: 'DEMO-••••-0000', is_default: true, status: 'CONNECTED', holder_name: 'NEHA KAPOOR', ifsc: 'DEMO0000001', branch: 'Demo Branch, Fort, Mumbai', link_status_label: 'Linked (simulated)' }

  it('links the chosen bank (a demo), shows the account found, then offers face set-up', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const api = mockApi({
      'GET /users/me': { body: customerProfile }, 'GET /banks/catalog': { body: catalog }, 'GET /banks': { body: [] },
      'POST /banks': { status: 201, body: made },
    })
    renderApp('/welcome')
    expect(await screen.findByText('Which bank is your mobile number linked to?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /HDFC Bank/ }))
    await user.click(screen.getByRole('button', { name: 'Find and link my account' }))
    const card = await screen.findByRole('region', { name: 'Account linked' })
    expect(card).toHaveTextContent('NEHA KAPOOR')
    expect(card).toHaveTextContent('DEMO-••••-0000')
    await user.click(within(card).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('heading', { name: 'HDFC Bank linked (demo)' })).toBeInTheDocument()
    expect(api.callsTo('POST /banks')[0].body).toEqual({ bank_code: 'hdfc' })
    expect(screen.getByRole('link', { name: 'Set up my face' })).toHaveAttribute('href', '/face')
  })

  it('lets the person skip the bank and warns that a payment needs one', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /banks/catalog': { body: catalog }, 'GET /banks': { body: [] } })
    renderApp('/welcome')
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByText(/You have not chosen a bank yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'I will do this later' })).toHaveAttribute('href', '/dashboard')
  })

  it('goes straight to face set-up when a bank is already connected', async () => {
    storeSession('customer')
    mockApi({ 'GET /users/me': { body: customerProfile }, 'GET /banks/catalog': { body: catalog }, 'GET /banks': { body: [made] } })
    renderApp('/welcome')
    expect(await screen.findByRole('link', { name: 'Set up my face' })).toBeInTheDocument()
    expect(screen.queryByText('Which bank is your mobile number linked to?')).not.toBeInTheDocument()
  })

  it('is for signed-in customers only', async () => {
    mockApi({})
    renderApp('/welcome')
    expect(await heading('Sign in')).toBeInTheDocument()
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
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(session()).toBeNull()
  })

  it('sends a merchant back to sign in', async () => {
    const user = userEvent.setup()
    storeSession('merchant')
    mockApi({ 'GET /merchants/me': { body: merchantProfile } })
    renderApp('/merchant/dashboard')
    await heading('SuperGrocery')
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await heading('Sign in')).toBeInTheDocument()
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

  it('shows a number account its mobile number, hides the phone field and saves only the name', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    const profile = { ...customerProfile, email: null, mobile: '9876543210', phone: '9876543210' }
    const api = mockApi({
      'GET /users/me': { body: profile },
      'PATCH /users/me': ({ body }) => ({ body: { ...profile, ...body } }),
    })
    renderApp('/profile')
    await heading('Profile')
    expect(screen.getByLabelText('Mobile number')).toHaveValue('+91 98765 43210')
    expect(screen.getByLabelText('Mobile number')).toBeDisabled()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Add your mobile number' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Full name'), 'a')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument()
    expect(api.callsTo('PATCH /users/me')[0].body).toEqual({ name: 'Asha Raoa' })
  })

  it('lets an older email account add its number with a demo code and a passcode', async () => {
    const user = userEvent.setup()
    storeSession('customer')
    let me = customerProfile
    const api = mockApi({
      'GET /users/me': () => ({ body: me }),
      'POST /auth/number/otp': { body: { challenge_id: 'chal-claim-123456', mobile_masked: '+91 •••••11111', expires_in: 300, resend_in: 30, demo: true, demo_code: '246013' } },
      'POST /auth/number/verify': { body: { verified: true } },
      'POST /auth/number/claim': () => { me = { ...customerProfile, mobile: '9811111111' }; return { body: { mobile: '9811111111', mobile_masked: '+91 •••••11111' } } },
    })
    renderApp('/profile')
    const card = await screen.findByRole('region', { name: 'Add your mobile number' })
    await user.type(within(card).getByLabelText('Mobile number'), '9811111111')
    await user.click(within(card).getByRole('button', { name: 'Continue' }))
    await within(card).findByRole('status', { name: 'Demo one-time code' })
    await user.type(within(card).getByLabelText('6-digit code'), '246013')
    await user.click(within(card).getByRole('button', { name: 'Verify' }))
    await user.type(await within(card).findByLabelText('Choose a 6-digit passcode'), '482915')
    await user.type(within(card).getByLabelText('Confirm passcode'), '482915')
    await user.click(within(card).getByRole('button', { name: 'Save number' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add your mobile number' })).not.toBeInTheDocument())
    expect(api.callsTo('POST /auth/number/otp')[0].body).toEqual({ mobile: '9811111111', purpose: 'claim' })
    expect(api.callsTo('POST /auth/number/claim')[0].body).toEqual({ challenge_id: 'chal-claim-123456', passcode: '482915' })
    expect(api.callsTo('POST /auth/number/claim')[0].headers.Authorization).toBe('Bearer token-for-customer')
    expect(screen.getByLabelText('Mobile number')).toHaveValue('+91 98111 11111')
    expect(screen.getByLabelText('Email')).toBeDisabled() // the email stays: same account
  })
})
