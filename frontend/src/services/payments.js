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
// The one-time ticket plus everything the customer was shown. The server compares each of them with the session and the
// ticket's own snapshot, and charges the session's own amount, never a value supplied here.
export const confirmPayment = (token, sessionId, { authorizationToken, expectedAmount, expectedMerchant, expectedOrderReference, pin }) =>
  apiFetch(`/payments/sessions/${enc(sessionId)}/confirm`, {
    method: 'POST', token,
    json: {
      authorization_token: authorizationToken,
      expected_amount: expectedAmount,
      expected_merchant: expectedMerchant,
      expected_order_reference: expectedOrderReference,
      ...(pin ? { pin } : {}),
    },
  })
// Transaction lists: { limit, offset, status, q, sort }. Only the parameters that are set are sent.
const query = (params) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, v)
  const text = sp.toString()
  return text ? `?${text}` : ''
}
export const getMyTransactions = (token, params = { limit: 20 }) => apiFetch(`/payments/transactions${query(params)}`, { token })
export const getMySummary = (token) => apiFetch('/payments/summary', { token })
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
export const getMerchantTransactions = (token, params = { limit: 10 }) => apiFetch(`/merchant/transactions${query(params)}`, { token })
export const getMerchantReceipt = (token, transactionId) => apiFetch(`/merchant/transactions/${enc(transactionId)}`, { token })
export const getMerchantSummary = (token) => apiFetch('/merchant/summary', { token })
