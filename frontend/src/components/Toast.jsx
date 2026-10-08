import { useCallback, useEffect, useRef, useState } from 'react'
import { ToastContext } from '../hooks/toastContext'
import Icon from './Icon'

/** Short confirmations for things that just happened ("Link copied"). Not for errors that need action. */
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const timer = useRef(null)
  const notify = useCallback((message) => {
    clearTimeout(timer.current)
    setToast({ message, id: Date.now() })
    timer.current = setTimeout(() => setToast(null), 3200)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div aria-live="polite" role="status" className="no-print pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-8">
        {toast && (
          <p key={toast.id} className="animate-toast pointer-events-auto flex items-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white shadow-pop">
            <Icon name="check" className="h-4 w-4 text-scan-edge" />
            {toast.message}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  )
}
