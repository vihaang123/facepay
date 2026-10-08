import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'
const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches

/** True when the person asked their system for less motion. Live, so changing the setting takes effect at once. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(QUERY)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}
