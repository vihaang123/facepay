const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status, fieldErrors = {}, code = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fieldErrors = fieldErrors
    this.code = code // machine-readable reason, e.g. "TOO_BLURRY" (face endpoints)
  }
}

// AuthProvider registers a callback so an expired/invalid session logs the user out.
let unauthorizedHandler = null
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn
}

async function parseError(response) {
  let detail = null
  try {
    detail = (await response.json())?.detail
  } catch {
    // non-JSON error body
  }
  if (typeof detail === 'string') {
    return new ApiError(detail, response.status)
  }
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.message) {
    return new ApiError(String(detail.message), response.status, {}, detail.code ?? null)
  }
  if (Array.isArray(detail)) {
    // FastAPI/Pydantic validation errors: [{ loc: ['body', 'password'], msg: '...' }]
    const fieldErrors = {}
    for (const item of detail) {
      const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : null
      const msg = String(item.msg || 'Invalid value').replace(/^Value error, /, '')
      if (field && !(field in fieldErrors)) fieldErrors[field] = msg
    }
    return new ApiError('Please fix the highlighted fields.', response.status, fieldErrors)
  }
  return new ApiError(`Request failed (${response.status})`, response.status)
}

export async function apiFetch(path, { token, json, headers, ...options } = {}) {
  const init = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
  }
  if (json !== undefined) init.body = JSON.stringify(json)

  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, init)
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0)
  }
  if (!response.ok) {
    const error = await parseError(response)
    // Only an authenticated request getting 401 means the session is no longer valid.
    if (response.status === 401 && token && unauthorizedHandler) unauthorizedHandler()
    throw error
  }
  if (response.status === 204) return null
  return response.json()
}

export const getHealth = () => apiFetch('/health')
