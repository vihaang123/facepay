import { createContext } from 'react'

// A no-op outside the provider, so components that toast still render in isolation.
export const ToastContext = createContext(() => {})
