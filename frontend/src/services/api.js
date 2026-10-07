const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiFetch(path, options = {}) {
  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0)
  }
  if (!response.ok) {
    throw new ApiError(`Request failed (${response.status})`, response.status)
  }
  return response.json()
}

export const getHealth = () => apiFetch('/health')
