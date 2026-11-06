import { useContext } from 'react'
import Icon from './Icon'
import { ThemeContext } from '../hooks/themeContext'

const OPTIONS = [
  ['system', 'System', 'monitor'],
  ['light', 'Light', 'sun'],
  ['dark', 'Dark', 'moon'],
]

/** The full theme choice: System follows the device, Light and Dark are fixed. Lives in Profile. */
export function ThemeSegmented() {
  const theme = useContext(ThemeContext)
  if (!theme) return null // outside a ThemeProvider there is nothing to choose
  const { preference, choose } = theme
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1">
      {OPTIONS.map(([value, label, icon]) => {
        const on = preference === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => choose(value)}
            className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition motion-reduce:transition-none ${on ? 'bg-surface text-fg shadow-card ring-1 ring-line' : 'text-muted hover:text-fg'}`}
          >
            <Icon name={icon} className="h-4 w-4" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** A one-tap switch for the header: flips between light and dark from whatever is showing now. */
export function ThemeIconButton({ className = '' }) {
  const theme = useContext(ThemeContext)
  if (!theme) return null
  const { resolved, choose } = theme
  const next = resolved === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      onClick={() => choose(next)}
      aria-label={`Switch to ${next} theme`}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition hover:bg-sunken hover:text-fg motion-reduce:transition-none ${className}`}
    >
      <Icon name={resolved === 'dark' ? 'sun' : 'moon'} className="h-5 w-5" />
    </button>
  )
}
