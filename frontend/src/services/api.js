const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

const SAFE_SERVER_CODES = new Set([
  'MODEL_VERSION_INCOMPATIBLE', 'MODEL_LOAD_FAILED', 'BIOMETRIC_DECRYPTION_FAILED', 'TRAINING_FAILED',
])

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

// What people read when the server gave us nothing better. Raw HTTP wording never reaches the screen.
const STATUS_MESSAGES = {
  400: 'That request could not be processed. Please check it and try again.',
  401: 'Please sign in to continue.',
  403: 'You do not have access to this.',
  404: 'We could not find that.',
  409: 'That is no longer possible because something changed. Please refresh and try again.',
  422: 'Some details are not valid. Please check them and try again.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong on our side. Please try again.',
  502: 'FacePay is temporarily unavailable. Please try again shortly.',
  503: 'FacePay is temporarily unavailable. Please try again shortly.',
  504: 'FacePay took too long to respond. Please try again.',
}
export const friendlyStatus = (status) =>
  STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : 'Something went wrong. Please try again.')

async function parseError(response) {
  let detail = null
  try {
    detail = (await response.json())?.detail
  } catch {
    // non-JSON error body
  }
  // A 5xx body is never shown (it could be a framework message); 4xx messages come from our own API. The exception is
  // a short list of codes the API itself raises with customer-safe wording (the recognition model is not ready).
  const knownCode = detail && typeof detail === 'object' && !Array.isArray(detail) && SAFE_SERVER_CODES.has(detail.code)
  const server = response.status < 500 || knownCode
  if (server && typeof detail === 'string') {
    return new ApiError(detail, response.status)
  }
  if (server && detail && typeof detail === 'object' && !Array.isArray(detail) && detail.message) {
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
    return new ApiError(
      Object.keys(fieldErrors).length ? 'Please fix the highlighted fields.' : friendlyStatus(response.status),
      response.status,
      fieldErrors,
    )
  }
  return new ApiError(friendlyStatus(response.status), response.status)
}

// Nothing waits forever: a request that gets no answer ends with a clear message.
const DEFAULT_TIMEOUT_MS = 30000

export async function apiFetch(path, { token, json, headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS, ...options } = {}) {
  const init = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
  }
  if (json !== undefined) init.body = JSON.stringify(json)

  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onCallerAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  init.signal = controller.signal

  let response
  try {
    response = await fetch(`${BASE_URL}${path}`, init)
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError('The server took too long to respond. Please try again.', 0, {}, 'TIMEOUT')
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
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
