import { useCallback, useEffect, useMemo, useState } from 'react'
import { setUnauthorizedHandler } from '../services/api'
import { fetchProfile, loginRequest, patchProfile, registerRequest } from '../services/auth'
import { normalizeRole } from '../utils/roles'
import { clearSession, loadSession, saveSession } from '../utils/session'
import { AuthContext } from './authContext'

const ANONYMOUS = { status: 'anonymous', token: null, role: null, profile: null }

export function AuthProvider({ children }) {
  // A stored session starts as "loading" until the server confirms the token is still valid.
  const [state, setState] = useState(() => {
    const stored = loadSession()
    return stored
      ? { status: 'loading', token: stored.token, role: normalizeRole(stored.role), profile: null }
      : ANONYMOUS
  })

  const logout = useCallback(() => {
    clearSession()
    setState(ANONYMOUS)
  }, [])

  // Any authenticated request that comes back 401 ends the session.
  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  // Validate a restored session by loading the profile.
  useEffect(() => {
    if (state.status !== 'loading') return undefined
    let cancelled = false
    fetchProfile(state.role, state.token)
      .then((profile) => {
        if (!cancelled) setState({ status: 'authenticated', token: state.token, role: state.role, profile })
      })
      .catch(() => {
        if (!cancelled) logout()
      })
    return () => {
      cancelled = true
    }
  }, [state.status, state.role, state.token, logout])

  const login = useCallback(async (role, email, password) => {
    const result = await loginRequest(role, { email, password })
    const sessionRole = normalizeRole(result.role)
    saveSession({ token: result.access_token, role: sessionRole, expiresInSeconds: result.expires_in })
    try {
      const profile = await fetchProfile(sessionRole, result.access_token)
      setState({ status: 'authenticated', token: result.access_token, role: sessionRole, profile })
    } catch (error) {
      clearSession()
      throw error
    }
  }, [])

  const register = useCallback(
    async (role, data) => {
      await registerRequest(role, data)
      await login(role, data.email, data.password)
    },
    [login],
  )

  const updateProfile = useCallback(
    async (changes) => {
      const profile = await patchProfile(state.role, state.token, changes)
      setState((s) => ({ ...s, profile }))
      return profile
    },
    [state.role, state.token],
  )

  const value = useMemo(
    () => ({ ...state, isAuthenticated: state.status === 'authenticated', login, register, logout, updateProfile }),
    [state, login, register, logout, updateProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
