import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'

// Keep tests independent: no leaked fetch mocks or stored sessions.
afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})
