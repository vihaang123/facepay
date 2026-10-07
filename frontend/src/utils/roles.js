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

export const FACE_PATH = '/face'
export const AUTHENTICATE_PATH = '/authenticate'
