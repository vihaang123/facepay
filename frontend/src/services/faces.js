import { apiFetch } from './api'

export const getEnrollment = (token) => apiFetch('/faces/enrollment', { token })

export const uploadSample = (token, { imageBase64, pose }) =>
  apiFetch('/faces/samples', { method: 'POST', token, json: { image_base64: imageBase64, pose } })

export const deleteSamples = (token) => apiFetch('/faces/samples', { method: 'DELETE', token })

export const trainModel = (token) => apiFetch('/faces/train', { method: 'POST', token })

export const getModel = (token) => apiFetch('/faces/model', { token })

export const recognize = (token, imageBase64) =>
  apiFetch('/faces/recognize', { method: 'POST', token, json: { image_base64: imageBase64 } })

// Stateless live check used by guided capture. The server stores nothing; the answer is guidance only.
export const giveConsent = (token) => apiFetch('/faces/consent', { method: 'POST', token })

export const assessFrame = (token, imageBase64, { signal, purpose = 'enroll' } = {}) =>
  apiFetch(`/faces/assess${purpose === 'auth' ? '?purpose=auth' : ''}`, { method: 'POST', token, json: { image_base64: imageBase64 }, signal })

// Why a face check can or cannot run right now (no image involved): { ready, code, message, next_action, ... }
export const getReadiness = (token) => apiFetch('/faces/readiness', { token })
