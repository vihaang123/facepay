import { useCallback, useEffect, useState } from 'react'

/**
 * Runs `fn` when `deps` change and on reload(). Returns { data, error, loading, reload }.
 * `error` is the user-facing message (the API layer already makes it friendly). A stale response never overwrites a newer one.
 */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => (s.loading ? s : { ...s, loading: true, error: null }))
    fn()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((err) => live && setState({ data: null, error: err.message || 'Something went wrong.', loading: false }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
