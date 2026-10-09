import { useCallback, useEffect, useRef, useState } from 'react'

/** Copies text and reports it for two seconds. Clipboard access can be refused, so the result says whether it worked. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return false
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
    return true
  }, [])
  return { copied, copy }
}
