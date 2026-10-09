import { apiFetch } from './api'

const enc = encodeURIComponent
const query = (params = {}) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, v)
  const text = sp.toString()
  return text ? `?${text}` : ''
}

// ---- wallet and FacePay ID
export const getWallet = (token) => apiFetch('/wallet', { token })
export const getMyFacePay = (token) => apiFetch('/facepay/me', { token })
export const changeFacePayId = (token, facepayId) => apiFetch('/facepay/me', { method: 'PUT', token, json: { facepay_id: facepayId } })
export const resolveRecipient = (token, id, { signal } = {}) => apiFetch(`/facepay/resolve${query({ id })}`, { token, signal })
export const resolveQr = (token, payload) => apiFetch('/facepay/qr/resolve', { method: 'POST', token, json: { payload } })
export const getContacts = (token) => apiFetch('/facepay/contacts', { token })

// ---- sending money. The review step prepares the payment; the face check and confirmation reuse the checkout routes.
export const prepareTransfer = (token, { recipient, amount, note }, idempotencyKey) =>
  apiFetch('/transfers', {
    method: 'POST', token,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    json: { recipient_facepay_id: recipient, amount, ...(note ? { note } : {}) },
  })
export const cancelTransfer = (token, sessionId) => apiFetch(`/transfers/${enc(sessionId)}/cancel`, { method: 'POST', token })

// ---- requests
export const createRequest = (token, { payer, amount, note }) =>
  apiFetch('/requests', { method: 'POST', token, json: { payer_facepay_id: payer, amount, ...(note ? { note } : {}) } })
export const listRequests = (token, params) => apiFetch(`/requests${query(params)}`, { token })
export const getRequest = (token, id) => apiFetch(`/requests/${enc(id)}`, { token })
export const payRequest = (token, id, idempotencyKey) =>
  apiFetch(`/requests/${enc(id)}/pay`, { method: 'POST', token, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined })
export const declineRequest = (token, id) => apiFetch(`/requests/${enc(id)}/decline`, { method: 'POST', token })
export const cancelRequest = (token, id) => apiFetch(`/requests/${enc(id)}/cancel`, { method: 'POST', token })

// ---- history
export const getActivity = (token, params = { limit: 20 }) => apiFetch(`/activity${query(params)}`, { token })
export const getActivityCounts = (token) => apiFetch('/activity/counts', { token })
export const getActivityDetail = (token, ref) => apiFetch(`/activity/${enc(ref)}`, { token })
