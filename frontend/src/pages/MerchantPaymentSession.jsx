import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Row, StatusBadge } from '../components/payUi'
import { Alert, Button, ButtonLink, Card, ConfirmPanel, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { cancelPaymentSession, getPaymentSession } from '../services/payments'
import { POLL } from '../utils/authTiming'
import { formatDateTime, formatMoney, isPayable } from '../utils/format'
import { DASHBOARD_PATH, NEW_PAYMENT_PATH, RECEIPT_PATH } from '../utils/roles'

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
  const [confirmCancel, setConfirmCancel] = useState(false)

  const open = session ? isPayable(session.status) : true
  useEffect(() => {
    let live = true
    const poll = () =>
      getPaymentSession(token, sessionId)
        .then((s) => { if (live) { setSession(s); setError(null) } })
        .catch((err) => { if (live) setError(err.status === 404 ? 'Payment session not found.' : err.status === 0 ? err.message : 'Could not refresh the status. Retrying…') })
    // A finished session never changes again: no request, no timer.
    if (!open) return undefined
    poll()
    const t = setInterval(poll, POLL.intervalMs)
    return () => { live = false; clearInterval(t) }
  }, [token, sessionId, open])

  const cancel = async () => {
    setConfirmCancel(false)
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
        <ButtonLink to={DASHBOARD_PATH.merchant} variant="secondary" className="self-start">Back to dashboard</ButtonLink>
      </div>
    )
  }

  const stage = { CREATED: 0, AUTHENTICATED: 1, PAID: 2 }[session.status]
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payment session</h1>
        <p aria-live="polite" className="mt-1 text-sm font-medium text-slate-800">{HEADLINE[session.status]}</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}

      <Card aria-label="Session details" flush>
        <div className="bg-slate-50 px-5 py-5 text-center">
          <p className="text-sm text-slate-700">Amount</p>
          <p className="mt-1 text-4xl font-bold tracking-tight">{formatMoney(session.amount, session.currency)}</p>
        </div>
        {stage !== undefined && (
          <ol aria-label="Payment progress" className="flex justify-between gap-2 border-b border-slate-100 px-5 py-3 text-xs">
            {['Created', 'Customer verified', 'Paid'].map((label, i) => (
              <li key={label} aria-current={i === stage && stage < 2 ? 'step' : undefined} className={i <= stage ? 'font-semibold text-emerald-800' : 'text-slate-600'}>
                <span aria-hidden="true">{i < stage || (i === stage && stage === 2) ? '✓ ' : `${i + 1}. `}</span>{label}
              </li>
            ))}
          </ol>
        )}
        <dl className="px-5 py-2">
          <Row label="Order">{session.order_reference}</Row>
          {session.description && <Row label="Details">{session.description}</Row>}
          <Row label="Status"><StatusBadge status={session.status} /></Row>
          <Row label="Created">{formatDateTime(session.created_at)}</Row>
          <Row label="Expires">{formatDateTime(session.expires_at)}</Row>
          {session.transaction_id && <Row label="Transaction"><span className="font-mono">{session.transaction_id}</span></Row>}
        </dl>
      </Card>

      {open && (
        <Card aria-label="Checkout link">
          <p className="text-sm text-slate-700">Send this link to the customer. They must sign in to a FacePay customer account.</p>
          <code className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs">{link}</code>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={copy}>Copy link</Button>
            {copied && <span role="status" className="text-xs text-emerald-800">Copied</span>}
            <Button variant="secondary" onClick={() => setConfirmCancel(true)} loading={busy} disabled={confirmCancel}>Cancel session</Button>
          </div>
          {confirmCancel && (
            <div className="mt-4">
              <ConfirmPanel title="Cancel this payment session?" confirmLabel="Cancel session" cancelLabel="Keep session" onConfirm={cancel} onCancel={() => setConfirmCancel(false)}>
                The checkout link stops working immediately and the customer will not be able to pay it.
              </ConfirmPanel>
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        {session.transaction_id && <ButtonLink to={RECEIPT_PATH.merchant(session.transaction_id)}>View transaction</ButtonLink>}
        <ButtonLink to={NEW_PAYMENT_PATH} variant="secondary">New payment</ButtonLink>
        <ButtonLink to={DASHBOARD_PATH.merchant} variant="secondary">Back to dashboard</ButtonLink>
      </div>
    </div>
  )
}
