import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Row, StatusBadge } from '../components/payUi'
import { Alert, Button, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { cancelPaymentSession, getPaymentSession } from '../services/payments'
import { POLL } from '../utils/authTiming'
import { formatDateTime, formatMoney, isPayable } from '../utils/format'
import { DASHBOARD_PATH, RECEIPT_PATH } from '../utils/roles'

const HEADLINE = {
  CREATED: 'Waiting for customer',
  AUTHENTICATED: 'Customer authenticated. Waiting for them to confirm',
  PAID: 'Payment completed',
  FAILED: 'Payment failed: too many failed face attempts',
  EXPIRED: 'Session expired',
  CANCELLED: 'Session cancelled',
}

export default function MerchantPaymentSession() {
  const { sessionId } = useParams()
  const { token } = useAuth()
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const open = session ? isPayable(session.status) : true
  useEffect(() => {
    let live = true
    const poll = () =>
      getPaymentSession(token, sessionId)
        .then((s) => { if (live) { setSession(s); setError(null) } })
        .catch((err) => { if (live) setError(err.status === 404 ? 'Payment session not found.' : err.status === 0 ? err.message : 'Could not refresh the status. Retrying…') })
    poll()
    if (!open) return () => { live = false }
    const t = setInterval(poll, POLL.intervalMs)
    return () => { live = false; clearInterval(t) }
  }, [token, sessionId, open])

  const cancel = async () => {
    setBusy(true)
    try {
      setSession(await cancelPaymentSession(token, sessionId))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const link = session ? `${window.location.origin}${session.checkout_path}` : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!session) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3">
        {error ? <Alert tone="error">{error}</Alert> : <Spinner label="Loading payment session" />}
        <Link className="text-sm font-semibold text-brand-600" to={DASHBOARD_PATH.merchant}>Back to dashboard</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payment session</h1>
        <p aria-live="polite" className="mt-1 text-sm font-medium text-slate-700">{HEADLINE[session.status]}</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <section aria-label="Session details" className="rounded-2xl border border-slate-200 bg-white p-5">
        <dl>
          <Row label="Amount"><span className="text-lg font-bold">{formatMoney(session.amount, session.currency)}</span></Row>
          <Row label="Order">{session.order_reference}</Row>
          {session.description && <Row label="Details">{session.description}</Row>}
          <Row label="Status"><StatusBadge status={session.status} /></Row>
          <Row label="Created">{formatDateTime(session.created_at)}</Row>
          <Row label="Expires">{formatDateTime(session.expires_at)}</Row>
          {session.transaction_id && <Row label="Transaction"><span className="font-mono">{session.transaction_id}</span></Row>}
        </dl>
      </section>
      {open && (
        <section aria-label="Checkout link" className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-600">Send this link to the customer. They must sign in to a FacePay customer account.</p>
          <code className="break-all rounded-lg bg-slate-100 px-3 py-2 text-xs">{link}</code>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={copy}>Copy link</Button>
            {copied && <span role="status" className="text-xs text-emerald-700">Copied</span>}
            <Button variant="secondary" onClick={cancel} loading={busy}>Cancel session</Button>
          </div>
        </section>
      )}
      <div className="flex gap-4">
        {session.transaction_id && (
          <Link className="text-sm font-semibold text-brand-600" to={RECEIPT_PATH.merchant(session.transaction_id)}>View receipt</Link>
        )}
        <Link className="text-sm font-semibold text-brand-600" to={DASHBOARD_PATH.merchant}>Back to dashboard</Link>
      </div>
    </div>
  )
}
