import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import AppRoutes from '../AppRoutes'
import { AuthProvider } from '../hooks/AuthProvider'

export const customerProfile = {
  id: 1,
  name: 'Asha Rao',
  email: 'asha@example.com',
  phone: null,
  role: 'customer',
  status: 'active',
  created_at: '2026-10-07T10:00:00Z',
}

export const merchantProfile = {
  id: 1,
  name: 'Ravi Shah',
  email: 'ravi@shop.example',
  business_name: 'SuperGrocery',
  created_at: '2026-10-07T10:00:00Z',
}

export const tokenResponse = (role) => ({
  access_token: `token-for-${role}`,
  token_type: 'bearer',
  expires_in: 3600,
  role,
})

const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/**
 * Replaces fetch. `routes` maps "METHOD /path" to { status, body } or a function returning it.
 * Returns the mock; `mock.calls` records { key, body, headers } for every request.
 */
export function mockApi(routes) {
  const calls = []
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${(init.method || 'GET').toUpperCase()} ${new URL(url).pathname}`
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ key, body, headers: init.headers })
    const handler = routes[key]
    if (!handler) return respond(404, { detail: `no mock for ${key}` })
    const result = typeof handler === 'function' ? handler({ body, headers: init.headers }) : handler
    return respond(result.status ?? 200, result.body)
  })
  fn.calls = calls
  fn.callsTo = (key) => calls.filter((c) => c.key === key)
  vi.stubGlobal('fetch', fn)
  return fn
}

export function storeSession(role, { expiresInMs = 3_600_000 } = {}) {
  window.localStorage.setItem(
    'facepay.session',
    JSON.stringify({ token: `token-for-${role}`, role, expiresAt: Date.now() + expiresInMs }),
  )
}

export function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  )
}
