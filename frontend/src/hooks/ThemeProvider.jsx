import { useCallback, useEffect, useMemo, useState } from 'react'
import { applyTheme, loadThemePreference, resolveTheme, saveThemePreference, systemPrefersDark } from '../utils/theme'
import { ThemeContext } from './themeContext'

/** Holds the person's theme choice (System, Light or Dark) and keeps <html data-theme> in step with it and with the device. */
export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(loadThemePreference)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  const resolved = resolveTheme(preference, systemDark)
  useEffect(() => applyTheme(resolved), [resolved])

  const choose = useCallback((next) => {
    setPreference(next)
    saveThemePreference(next)
  }, [])

  const value = useMemo(() => ({ preference, resolved, choose }), [preference, resolved, choose])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
