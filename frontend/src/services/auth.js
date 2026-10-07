import { apiFetch } from './api'

const ENDPOINTS = {
  customer: { login: '/auth/login', register: '/auth/register', me: '/users/me' },
  merchant: { login: '/auth/merchant/login', register: '/auth/merchant/register', me: '/merchants/me' },
}

export const loginRequest = (role, { email, password }) =>
  apiFetch(ENDPOINTS[role].login, { method: 'POST', json: { email, password } })

export const registerRequest = (role, data) =>
  apiFetch(ENDPOINTS[role].register, { method: 'POST', json: data })

export const fetchProfile = (role, token) => apiFetch(ENDPOINTS[role].me, { token })

export const patchProfile = (role, token, changes) =>
  apiFetch(ENDPOINTS[role].me, { method: 'PATCH', token, json: changes })
