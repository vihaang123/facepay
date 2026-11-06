import { useEffect, useState } from 'react'

const read = (q) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches

/** Live result of a CSS media query. False where the browser cannot answer (tests), so the phone layout is the fallback. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => read(query))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [query])
  return matches
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
