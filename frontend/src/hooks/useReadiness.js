import { useCallback, useEffect, useRef, useState } from 'react'
import { getReadiness } from '../services/faces'

/**
 * Whether a face check can run right now. `state` is null while the first answer is awaited, then the server's report
 * ({ ready, code, message, next_action, ... }). A failed lookup is its own state, so a network problem is never shown as
 * a model problem. Nothing is retried on a timer: call recheck().
 */
export function useReadiness(token, { enabled = true } = {}) {
  const [state, setState] = useState(null)
  const [lookupError, setLookupError] = useState(null)
  const [checking, setChecking] = useState(false)
  const live = useRef(true)
  const inFlight = useRef(false)

  const recheck = useCallback(async () => {
    if (!enabled || inFlight.current) return null
    inFlight.current = true
    setChecking(true)
    try {
      const next = await getReadiness(token)
      if (live.current) { setState(next); setLookupError(null) }
      return next
    } catch (err) {
      if (live.current) setLookupError(err?.message || 'The model status could not be checked.')
      return null
    } finally {
      inFlight.current = false
      if (live.current) setChecking(false)
    }
  }, [token, enabled])

  useEffect(() => {
    live.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    recheck()
    return () => { live.current = false }
  }, [recheck])

  return { state, setState, lookupError, checking, recheck }
}
