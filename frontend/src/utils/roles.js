export const ROLES = { CUSTOMER: 'customer', MERCHANT: 'merchant', ADMIN: 'admin' }

// Three roles, three separate areas. Anything unrecognised is an ordinary customer. The server decides what each role may
// call; this only picks which screens to show.
export const normalizeRole = (role) => (role === ROLES.MERCHANT || role === ROLES.ADMIN ? role : ROLES.CUSTOMER)

export const DASHBOARD_PATH = {
  customer: '/dashboard',
  merchant: '/merchant/dashboard',
  admin: '/admin',
}

export const LOGIN_PATH = {
  customer: '/login',
  merchant: '/merchant/login',
  admin: '/login',
}

export const PROFILE_PATH = {
  customer: '/profile',
  merchant: '/merchant/profile',
  admin: '/admin',
}

export const TRANSACTIONS_PATH = { customer: '/activity', merchant: '/merchant/transactions', admin: '/admin' }

export const FACE_PATH = '/face'
export const SECURITY_PATH = '/security'
export const AUTHENTICATE_PATH = '/authenticate'
export const PAY_PATH = '/pay'

export const CHECKOUT_PATH = (sessionId) => `/checkout/${sessionId}`
export const RECEIPT_PATH = { customer: (id) => `/receipts/${id}`, merchant: (id) => `/merchant/receipts/${id}` }
export const NEW_PAYMENT_PATH = '/merchant/payments/new'
export const MERCHANT_SESSION_PATH = (sessionId) => `/merchant/payments/${sessionId}`

// ---- customer money screens
export const SEND_PATH = '/send'
export const REQUEST_PATH = '/request'
export const REQUESTS_PATH = '/requests'
export const SCAN_PATH = '/scan'
export const MY_QR_PATH = '/my-qr'
export const ACTIVITY_PATH = '/activity'
export const ACTIVITY_DETAIL_PATH = (ref) => `/activity/${ref}`
export const FACEPAY_ID_PATH = '/facepay-id'

/** Deep link into Send with a recipient already chosen (from QR, contacts or a request). Only the ID travels in the URL. */
export const sendTo = (id, amount) => `${SEND_PATH}?to=${encodeURIComponent(id)}${amount ? `&amount=${encodeURIComponent(amount)}` : ''}`

// ---- admin
export const ADMIN_PATH = '/admin'
