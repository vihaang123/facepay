import { apiFetch } from './api'

export const getEnrollment = (token) => apiFetch('/faces/enrollment', { token })

export const uploadSample = (token, { imageBase64, pose }) =>
  apiFetch('/faces/samples', { method: 'POST', token, json: { image_base64: imageBase64, pose } })

export const deleteSamples = (token) => apiFetch('/faces/samples', { method: 'DELETE', token })

export const trainModel = (token) => apiFetch('/faces/train', { method: 'POST', token })

export const getModel = (token) => apiFetch('/faces/model', { token })

export const recognize = (token, imageBase64) =>
  apiFetch('/faces/recognize', { method: 'POST', token, json: { image_base64: imageBase64 } })
