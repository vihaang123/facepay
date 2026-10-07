import { describe, expect, it } from 'vitest'
import { clearSession, loadSession, saveSession } from './session'
import { normalizeRole } from './roles'
import { runValidators, validateEmail, validatePassword, validatePhone, validateRequired } from './validation'

describe('validation', () => {
  it('validates email', () => {
    expect(validateEmail('a@b.co')).toBeNull()
    expect(validateEmail(' a@b.co ')).toBeNull()
    for (const bad of ['', 'abc', 'a@b', '@b.co', 'a b@c.de']) expect(validateEmail(bad)).not.toBeNull()
  })

  it('validates password strength like the backend', () => {
    expect(validatePassword('Correct-horse-42')).toBeNull()
    expect(validatePassword('short1')).toMatch(/at least 8/)
    expect(validatePassword('onlyletters')).toMatch(/letter and a number/)
    expect(validatePassword('12345678')).toMatch(/letter and a number/)
    expect(validatePassword('a1'.repeat(70))).toMatch(/at most 128/)
    expect(validatePassword('')).not.toBeNull()
  })

  it('treats phone as optional but strict when present', () => {
    expect(validatePhone('')).toBeNull()
    expect(validatePhone(undefined)).toBeNull()
    expect(validatePhone('+91 98765-43210')).toBeNull()
    expect(validatePhone('abc')).not.toBeNull()
    expect(validatePhone('123')).not.toBeNull()
  })

  it('requires non-blank values', () => {
    expect(validateRequired('Name')('  ')).toBe('Name is required')
    expect(validateRequired('Name')('A')).toBeNull()
  })

  it('runValidators returns only failing fields', () => {
    const errors = runValidators(
      { email: 'bad', name: 'ok' },
      { email: validateEmail, name: validateRequired('Name') },
    )
    expect(Object.keys(errors)).toEqual(['email'])
  })
})

describe('session storage', () => {
  it('round-trips a session', () => {
    saveSession({ token: 't', role: 'customer', expiresInSeconds: 60 })
    expect(loadSession()).toMatchObject({ token: 't', role: 'customer' })
  })

  it('drops and clears an expired session', () => {
    saveSession({ token: 't', role: 'customer', expiresInSeconds: -1 })
    expect(loadSession()).toBeNull()
    expect(window.localStorage.getItem('facepay.session')).toBeNull()
  })

  it('ignores corrupt or incomplete data', () => {
    window.localStorage.setItem('facepay.session', '{not json')
    expect(loadSession()).toBeNull()
    window.localStorage.setItem('facepay.session', JSON.stringify({ token: 't' }))
    expect(loadSession()).toBeNull()
  })

  it('clearSession removes the session', () => {
    saveSession({ token: 't', role: 'merchant', expiresInSeconds: 60 })
    clearSession()
    expect(loadSession()).toBeNull()
  })
})

describe('roles', () => {
  it('treats anything but merchant as customer', () => {
    expect(normalizeRole('merchant')).toBe('merchant')
    expect(normalizeRole('customer')).toBe('customer')
    expect(normalizeRole('admin')).toBe('customer')
    expect(normalizeRole(undefined)).toBe('customer')
  })
})
