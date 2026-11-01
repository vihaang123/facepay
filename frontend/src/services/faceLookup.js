import { apiFetch } from './api'

const enc = encodeURIComponent

// Point a camera at someone: the server says whether they are a FacePay customer who allows it, and gives a single-use ticket.
export const findByFace = (token, frames, { signal } = {}) =>
  apiFetch('/face-lookup', { method: 'POST', token, json: { frames }, signal, timeoutMs: 45000 })

// "Let shops and friends find me by face" (off until the customer turns it on).
export const setFaceLookup = (token, enabled) => apiFetch('/security/face-lookup', { method: 'PUT', token, json: { enabled } })

// What is waiting for this customer to approve (customer requests and shop bills), for the pop-up.
export const getIncoming = (token, { signal } = {}) => apiFetch('/requests/incoming/prompts', { token, signal })

// A shop asks the customer it just scanned.
export const createFaceRequest = (token, { lookupToken, amount, purpose, reference, description, expiresInMinutes }) =>
  apiFetch('/merchant/payment-sessions/by-face', {
    method: 'POST', token,
    json: {
      lookup_token: lookupToken, amount, purpose, order_reference: reference,
      ...(description ? { description } : {}), ...(expiresInMinutes ? { expires_in_minutes: expiresInMinutes } : {}),
    },
  })

// The customer says no to a bill a shop addressed to them.
export const declineShopRequest = (token, sessionId) => apiFetch(`/payments/sessions/${enc(sessionId)}/decline`, { method: 'POST', token })
