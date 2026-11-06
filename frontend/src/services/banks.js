import { apiFetch } from './api'

const enc = encodeURIComponent

// Simulated bank connections. The client sends only a bank code and an account type: the bank name, the masked demo
// reference and every status come from the server. No credential is ever sent or stored.
export const getBankCatalog = (token) => apiFetch('/banks/catalog', { token })
export const getMyBanks = (token) => apiFetch('/banks', { token })
// Links the account the discovery provider finds at this bank. Only the bank is sent: the holder name, account type, masked
// number, IFSC and branch all come back from the server.
export const connectBank = (token, { bankCode }) => apiFetch('/banks', { method: 'POST', token, json: { bank_code: bankCode } })
export const makeDefaultBank = (token, connectionId) => apiFetch(`/banks/${enc(connectionId)}/default`, { method: 'POST', token })
export const disconnectBank = (token, connectionId) => apiFetch(`/banks/${enc(connectionId)}`, { method: 'DELETE', token })
// The owner's DEMO switch for how a simulated account answers a payment: NORMAL | DECLINE | TIMEOUT.
export const setBankBehavior = (token, connectionId, behavior) =>
  apiFetch(`/banks/${enc(connectionId)}/behavior`, { method: 'PATCH', token, json: { behavior } })
