import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Icon from './Icon'
import { Alert, Avatar, Button } from './ui'
import { useAuth } from '../hooks/useAuth'
import { declineShopRequest, getIncoming } from '../services/faceLookup'
import { declineRequest, payRequest } from '../services/transfers'
import { formatDateTime, formatMoney } from '../utils/format'
import { newKey } from '../utils/money'
import { CHECKOUT_PATH } from '../utils/roles'

export const PROMPT_POLL_MS = 5000
const STORE = 'facepay.dismissedPrompts'

const readDismissed = () => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(STORE) ?? '[]'))
  } catch {
    return new Set()
  }
}
const saveDismissed = (set) => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify([...set].slice(-50)))
  } catch {
    // storage can be blocked; the pop-up then simply may show again after a reload
  }
}

// Screens where a pop-up would interrupt a payment in progress or a face check.
const QUIET = ['/checkout/', '/authenticate', '/face']

/**
 * The pop-up a customer sees when someone asks them for money: a customer's request or a bill a shop addressed to them. It
 * shows who is asking, how much, what for and the reference they wrote. "Review and pay" opens the normal payment, where the
 * customer still verifies their own face and confirms; nothing is paid from this pop-up.
 *
 * It checks for new requests every few seconds while FacePay is open in the browser. It is not a phone notification: nothing
 * can reach a closed app.
 */
export default function IncomingRequestPrompt() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [items, setItems] = useState([])
  const [dismissed, setDismissed] = useState(readDismissed)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const primary = useRef(null)

  useEffect(() => {
    if (!token) return undefined
    const controller = new AbortController()
    // A missed check is silent; the next one tries again.
    const poll = () => getIncoming(token, { signal: controller.signal }).then(setItems, () => {})
    const timer = setInterval(() => { if (!document.hidden) poll() }, PROMPT_POLL_MS)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    const first = setTimeout(poll, 0)
    return () => {
      controller.abort()
      clearTimeout(first)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [token])

  const quiet = QUIET.some((p) => pathname.startsWith(p))
  const item = quiet ? null : items.find((i) => !dismissed.has(i.ref)) ?? null

  useEffect(() => {
    if (item) primary.current?.focus()
  }, [item])

  const dismiss = useCallback((ref) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(ref)
      saveDismissed(next)
      return next
    })
    setError(null)
  }, [])

  useEffect(() => {
    if (!item) return undefined
    const onKey = (e) => { if (e.key === 'Escape') dismiss(item.ref) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [item, dismiss])

  if (!item) return null

  const review = async () => {
    setBusy('pay')
    setError(null)
    try {
      if (item.kind === 'SHOP') {
        navigate(CHECKOUT_PATH(item.ref))
      } else {
        const session = await payRequest(token, item.ref, newKey())
        navigate(CHECKOUT_PATH(session.session_id))
      }
      dismiss(item.ref)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const decline = async () => {
    setBusy('decline')
    setError(null)
    try {
      if (item.kind === 'SHOP') await declineShopRequest(token, item.ref)
      else await declineRequest(token, item.ref)
      dismiss(item.ref)
      setItems((list) => list.filter((i) => i.ref !== item.ref))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 sm:items-center" data-testid="incoming-request">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-title"
        aria-describedby="incoming-body"
        className="w-full max-w-sm rounded-3xl bg-surface p-6 shadow-2xl motion-safe:animate-pop"
      >
        <div className="flex items-center gap-3">
          <Avatar name={item.from_name} />
          <div className="min-w-0">
            <h2 id="incoming-title" className="truncate text-lg font-bold leading-tight">{item.from_name} is asking for money</h2>
            <p className="font-mono text-xs text-muted">{item.from_detail}</p>
          </div>
        </div>

        <p className="amount mt-4 text-center text-4xl font-bold">{formatMoney(item.amount, item.currency)}</p>
        <dl id="incoming-body" className="mt-4 divide-y divide-line rounded-xl bg-sunken px-3 text-sm">
          {item.purpose_label && (
            <div className="flex justify-between gap-3 py-2"><dt className="text-muted">For</dt><dd className="font-semibold">{item.purpose_label}</dd></div>
          )}
          <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Reference</dt><dd className="text-right font-semibold">{item.reference ?? '—'}</dd></div>
          <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Valid until</dt><dd className="font-semibold">{formatDateTime(item.expires_at)}</dd></div>
        </dl>

        <p className="mt-3 flex items-start gap-2 text-xs text-fg">
          <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
          Only pay someone you know and expect. FacePay never asks for OTPs, PINs or passwords. You will verify your face before anything is paid.
        </p>

        {error && <Alert tone="error" className="mt-3">{error}</Alert>}
        <div className="mt-4 flex flex-col gap-2">
          <Button ref={primary} size="lg" onClick={review} loading={busy === 'pay'} disabled={busy === 'decline'}>Review and pay</Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={decline} loading={busy === 'decline'} disabled={busy === 'pay'}>Decline</Button>
            <Button variant="ghost" onClick={() => dismiss(item.ref)} disabled={Boolean(busy)}>Not now</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
