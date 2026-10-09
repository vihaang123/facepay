import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Icon from '../components/Icon'
import { Amount, Row, SimulatedTag, StatusBadge, Timeline } from '../components/payUi'
import QrCode from '../components/QrCode'
import { Alert, Button, ButtonLink, Card, ConfirmPanel, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { cancelPaymentSession, getPaymentSession } from '../services/payments'
import { POLL } from '../utils/authTiming'
import { formatDateTime, isPayable } from '../utils/format'
import { merchantTimeline } from '../utils/timeline'
import { DASHBOARD_PATH, NEW_PAYMENT_PATH, RECEIPT_PATH } from '../utils/roles'

const HEADLINE = {
  CREATED: 'Awaiting customer',
  AUTHENTICATED: 'Customer authenticated, awaiting confirmation',
  PAID: 'Payment completed',
  FAILED: 'Payment failed after too many face attempts',
  EXPIRED: 'Request expired',
  CANCELLED: 'Request cancelled',
}

export default function MerchantPaymentSession() {
  const { sessionId } = useParams()
  const { token } = useAuth()
  const notify = useToast()
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
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
      notify('Payment request cancelled')
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
      notify('Link copied')
    } catch {
      notify('Could not copy. Select the link and copy it manually.')
    }
  }

  if (!session) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3">
        {error ? <Alert tone="error">{error}</Alert> : <div role="status" aria-label="Loading payment session"><Skeleton className="h-80 w-full !rounded-[1.5rem]" /></div>}
        <ButtonLink to={DASHBOARD_PATH.merchant} variant="secondary">Back to home</ButtonLink>
      </div>
    )
  }

  const ok = session.status === 'PAID'
  const stopped = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(session.status)
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <h1 className="text-2xl font-extrabold tracking-tight">Payment request</h1>
      {error && <Alert tone="error">{error}</Alert>}

      <section aria-label="Session details" className="rounded-[1.5rem] border border-slate-200/80 bg-white p-6 text-center shadow-card">
        <Amount value={session.amount} currency={session.currency} className="text-5xl" />
        <p aria-live="polite" className={`mt-2 inline-flex items-center gap-2 text-base font-bold ${ok ? 'text-emerald-800' : stopped ? 'text-rose-800' : 'text-slate-900'}`}>
          {!ok && !stopped && <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-brand-600" />}
          {ok && <Icon name="check" className="h-5 w-5" strokeWidth="2.6" />}
          {HEADLINE[session.status]}
        </p>
        <p className="mt-1 font-mono text-sm text-slate-700">{session.order_reference}</p>
        <div><SimulatedTag className="mt-3" /></div>
      </section>

      <Card title="Progress">
        <Timeline steps={merchantTimeline(session.status)} label="Payment progress" />
      </Card>

      <Card aria-label="Details" className="!py-2">
        <dl>
          {session.description && <Row label="Details">{session.description}</Row>}
          <Row label="Status"><StatusBadge status={session.status} /></Row>
          <Row label="Created">{formatDateTime(session.created_at)}</Row>
          <Row label="Expires">{formatDateTime(session.expires_at)}</Row>
          {session.transaction_id && <Row label="Transaction"><span className="font-mono">{session.transaction_id}</span></Row>}
        </dl>
      </Card>

      {open && (
        <Card aria-label="Checkout link">
          <p className="text-sm text-slate-700">Send this link to the customer. They sign in to a FacePay customer account and pay with their face.</p>
          <code className="mt-2 block break-all rounded-xl bg-slate-100 px-3 py-2 text-xs">{link}</code>
          {isPayable(session.status) && (
            <div className="mt-4 flex flex-col items-center gap-2">
              <QrCode value={link} size={176} label="QR code for this payment link" />
              <p className="text-center text-xs text-slate-600">Or let the customer scan this code from FacePay. It points to this one payment only and stops working when it is paid or expires.</p>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={copy}><Icon name="link" className="h-4 w-4" />Copy link</Button>
            <Button variant="secondary" onClick={() => setConfirmCancel(true)} loading={busy} disabled={confirmCancel}>Cancel request</Button>
          </div>
          {confirmCancel && (
            <div className="mt-4">
              <ConfirmPanel title="Cancel this payment request?" confirmLabel="Cancel request" cancelLabel="Keep request" onConfirm={cancel} onCancel={() => setConfirmCancel(false)}>
                The checkout link stops working immediately and the customer will not be able to pay it.
              </ConfirmPanel>
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {session.transaction_id && <ButtonLink to={RECEIPT_PATH.merchant(session.transaction_id)} size="lg">View transaction</ButtonLink>}
        <ButtonLink to={NEW_PAYMENT_PATH} variant="secondary" size="lg">New payment</ButtonLink>
        <ButtonLink to={DASHBOARD_PATH.merchant} variant="ghost">Back to home</ButtonLink>
      </div>
    </div>
  )
}
