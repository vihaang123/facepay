import { apiFetch } from './api'

export const requestChallenge = (token) => apiFetch('/face-auth/challenge', { method: 'POST', token })

export const verifyFace = (token, { challengeId, frames }, { signal } = {}) =>
  apiFetch('/face-auth/verify', { method: 'POST', token, json: { challenge_id: challengeId, frames }, signal })

export const getAttempts = (token, limit = 5) => apiFetch(`/face-auth/attempts?limit=${limit}`, { token })
