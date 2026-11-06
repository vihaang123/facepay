// Theme preference: 'system' (follow the device), 'light' or 'dark'. Stored on this device only, under the same guarded
// localStorage convention as the session. index.html runs the same resolution before first paint so there is no flash.
export const THEME_KEY = 'facepay.theme'
export const THEME_CHOICES = ['system', 'light', 'dark']
export const THEME_COLOR = { light: '#ffffff', dark: '#0b0d12' } // the browser/phone status bar colour for each theme

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function systemPrefersDark() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

export function loadThemePreference() {
  try {
    const v = window.localStorage.getItem(THEME_KEY)
    return THEME_CHOICES.includes(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

export function saveThemePreference(pref) {
  try {
    if (pref === 'system') window.localStorage.removeItem(THEME_KEY)
    else window.localStorage.setItem(THEME_KEY, pref)
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}

export const resolveTheme = (pref, systemDark) => (pref === 'dark' || (pref === 'system' && systemDark) ? 'dark' : 'light')

export function applyTheme(resolved) {
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
}
