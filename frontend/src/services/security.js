import { apiFetch } from './api'

export const getSecurityOverview = (token) => apiFetch('/security/overview', { token })
export const setBiometricEnabled = (token, enabled) => apiFetch('/security/biometric', { method: 'PUT', token, json: { enabled } })
export const setPaymentPin = (token, { password, newPin }) =>
  apiFetch('/security/pin', { method: 'PUT', token, json: { password, new_pin: newPin } })
export const removePaymentPin = (token, { password }) => apiFetch('/security/pin/remove', { method: 'POST', token, json: { password } })
