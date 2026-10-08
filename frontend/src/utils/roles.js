export const ROLES = { CUSTOMER: 'customer', MERCHANT: 'merchant' }

// The backend may report role "admin" for users-table accounts; the UI treats them as customers.
export const normalizeRole = (role) => (role === ROLES.MERCHANT ? ROLES.MERCHANT : ROLES.CUSTOMER)

export const DASHBOARD_PATH = {
  customer: '/dashboard',
  merchant: '/merchant/dashboard',
}

export const LOGIN_PATH = {
  customer: '/login',
  merchant: '/merchant/login',
}

export const PROFILE_PATH = {
  customer: '/profile',
  merchant: '/merchant/profile',
}

export const TRANSACTIONS_PATH = { customer: '/transactions', merchant: '/merchant/transactions' }

export const FACE_PATH = '/face'
export const AUTHENTICATE_PATH = '/authenticate'
export const PAY_PATH = '/pay'

export const CHECKOUT_PATH = (sessionId) => `/checkout/${sessionId}`
export const RECEIPT_PATH = { customer: (id) => `/receipts/${id}`, merchant: (id) => `/merchant/receipts/${id}` }
export const NEW_PAYMENT_PATH = '/merchant/payments/new'
export const MERCHANT_SESSION_PATH = (sessionId) => `/merchant/payments/${sessionId}`
