import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Home from './Home'

afterEach(() => vi.restoreAllMocks())

describe('Home status page', () => {
  it('shows connected state when the API reports a healthy database', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', database: 'ok' }) }),
    )
    render(<Home />)
    expect(await screen.findByText('Backend API')).toBeInTheDocument()
    expect((await screen.findAllByText('Connected')).length).toBe(2)
  })

  it('shows an error when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    render(<Home />)
    expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument()
  })
})
