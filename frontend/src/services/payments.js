import { apiFetch } from './api'

const enc = encodeURIComponent

// ---- customer
export const getCheckout = (token, sessionId) => apiFetch(`/payments/sessions/${enc(sessionId)}`, { token })
export const startPaymentAuth = (token, sessionId) =>
  apiFetch(`/payments/sessions/${enc(sessionId)}/authenticate/start`, { method: 'POST', token })
export const authenticateForPayment = (token, sessionId, { challengeId, frames }, { signal } = {}) =>
  apiFetch(`/payments/sessions/${enc(sessionId)}/authenticate`, {
    method: 'POST', token, json: { challenge_id: challengeId, frames }, signal,
  })
// Only the one-time ticket and the amount the customer was shown. The server charges the session's own amount.
export const confirmPayment = (token, sessionId, { authorizationToken, expectedAmount }) =>
  apiFetch(`/payments/sessions/${enc(sessionId)}/confirm`, {
    method: 'POST', token, json: { authorization_token: authorizationToken, expected_amount: expectedAmount },
  })
export const getMyTransactions = (token, limit = 20) => apiFetch(`/payments/transactions?limit=${limit}`, { token })
export const getMyReceipt = (token, transactionId) => apiFetch(`/payments/transactions/${enc(transactionId)}`, { token })

// ---- merchant
export const createPaymentSession = (token, { amount, orderReference, description, expiresInMinutes }) =>
  apiFetch('/merchant/payment-sessions', {
    method: 'POST', token,
    json: { amount, order_reference: orderReference, ...(description ? { description } : {}), expires_in_minutes: expiresInMinutes },
  })
export const getPaymentSession = (token, sessionId) => apiFetch(`/merchant/payment-sessions/${enc(sessionId)}`, { token })
export const listPaymentSessions = (token, limit = 10) => apiFetch(`/merchant/payment-sessions?limit=${limit}`, { token })
export const cancelPaymentSession = (token, sessionId) =>
  apiFetch(`/merchant/payment-sessions/${enc(sessionId)}/cancel`, { method: 'POST', token })
export const getMerchantTransactions = (token, limit = 10) => apiFetch(`/merchant/transactions?limit=${limit}`, { token })
export const getMerchantReceipt = (token, transactionId) => apiFetch(`/merchant/transactions/${enc(transactionId)}`, { token })
export const getMerchantSummary = (token) => apiFetch('/merchant/summary', { token })
