import { apiFetch } from './api'

const ENDPOINTS = {
  customer: { login: '/auth/login', me: '/users/me' },
  admin: { login: '/auth/login', me: '/users/me' }, // an administrator is a customer account with the admin role
  merchant: { login: '/auth/merchant/login', me: '/merchants/me' },
}

export const loginRequest = (role, { email, password }) =>
  apiFetch(ENDPOINTS[role].login, { method: 'POST', json: { email, password } })

export const fetchProfile = (role, token) => apiFetch(ENDPOINTS[role].me, { token })

export const patchProfile = (role, token, changes) =>
  apiFetch(ENDPOINTS[role].me, { method: 'PATCH', token, json: changes })
