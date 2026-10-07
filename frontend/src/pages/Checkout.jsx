import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthDetails } from '../components/AuthStages'
import FaceAuthFlow from '../components/FaceAuthFlow'
import { Receipt, Row, StatusBadge } from '../components/payUi'
import { Alert, Button, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { ApiError } from '../services/api'
import { authenticateForPayment, confirmPayment, getCheckout, startPaymentAuth } from '../services/payments'
import { DASHBOARD_PATH, RECEIPT_PATH } from '../utils/roles'
import { formatDateTime, formatMoney, isPayable } from '../utils/format'

const TERMINAL_MESSAGES = {
  PAID: 'This payment has already been completed.',
  EXPIRED: 'This payment session has expired. Ask the merchant for a new one.',
  CANCELLED: 'The merchant cancelled this payment session.',
  FAILED: 'Too many failed face authentication attempts. Ask the merchant for a new payment session.',
}

const CONFIRM_ERRORS = {
  AUTHORIZATION_EXPIRED: 'Your face authorization expired. Authenticate again to continue.',
  AUTHORIZATION_INVALID: 'Your face authorization is no longer valid. Authenticate again to continue.',
  AUTHORIZATION_USED: 'That authorization was already used. Authenticate again to continue.',
  AMOUNT_MISMATCH: 'The amount for this payment changed. Please review it and authenticate again.',
  SESSION_ALREADY_PAID: 'This payment was already completed. Check your payment history before paying again.',
}

function describeLoadError(err) {
  return {
    notFound: err.status === 404,
    message:
      err.status === 404 ? 'This payment session does not exist.'
      : err.status === 403 ? 'Only customers can pay. Sign in with a customer account.'
      : err.status >= 500 ? 'Something went wrong on our side. Please try again.'
      : err.message,
  }
}

function useSecondsLeft(expiresAt) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000))
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function Authorized({ session, auth, outcome, busy, error, onConfirm, onRestart }) {
  const left = useSecondsLeft(auth.expiresAt)
  const expired = left === 0
  return (
    <section aria-label="Confirm payment" className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-emerald-700">FacePay Authentication ✓</h2>
      <AuthDetails result={outcome} />
      <div>
        <p className="text-sm text-slate-500">Amount</p>
        <p className="text-3xl font-bold tracking-tight">{formatMoney(session.amount, session.currency)}</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {expired ? (
        <>
          <Alert tone="error">Your face authorization expired. Authenticate again to continue.</Alert>
          <div><Button onClick={onRestart}>Authenticate again</Button></div>
        </>
      ) : (
        <>
          <p className="text-xs text-slate-500">Authorization valid for {clock(left)}. It can be used once.</p>
          <div className="flex gap-3">
            <Button onClick={onConfirm} loading={busy}>Confirm {formatMoney(session.amount, session.currency)}</Button>
            <Button variant="secondary" onClick={onRestart} disabled={busy}>Cancel</Button>
          </div>
        </>
      )}
    </section>
  )
}

export default function Checkout() {
  const { sessionId } = useParams()
  const { token, role } = useAuth()
  const [session, setSession] = useState(null)
  const [loadError, setLoadError] = useState(null) // { message, notFound }
  const [step, setStep] = useState('summary') // summary | authenticating | authorized | processing | paid
  const [notice, setNotice] = useState(null)
  const [auth, setAuth] = useState(null) // { token, expiresAt }
  const [outcome, setOutcome] = useState(null)
  const [confirmError, setConfirmError] = useState(null)
  const [receipt, setReceipt] = useState(null)

  const load = useCallback(async () => {
    try {
      setSession(await getCheckout(token, sessionId))
      setLoadError(null)
    } catch (err) {
      setLoadError(describeLoadError(err))
    }
  }, [token, sessionId])

  useEffect(() => {
    let live = true
    getCheckout(token, sessionId)
      .then((s) => { if (live) { setSession(s); setLoadError(null) } })
      .catch((err) => { if (live) setLoadError(describeLoadError(err)) })
    return () => { live = false }
  }, [token, sessionId])

  const restart = () => { setAuth(null); setOutcome(null); setConfirmError(null); setStep('summary') }

  const onOutcome = (result) => {
    setSession((s) => ({ ...s, status: result.session_status, attempts_remaining: result.attempts_remaining }))
    if (result.result === 'AUTHENTICATED' && result.authorization) {
      setAuth({ token: result.authorization.authorization_token, expiresAt: result.authorization.expires_at })
      setOutcome(result)
      setConfirmError(null)
      setStep('authorized')
    }
  }

  const onAuthError = (err) => {
    if (err.status === 404 || err.status === 409) load() // the session changed under us: show its real state
  }

  const confirm = async () => {
    setStep('processing')
    setConfirmError(null)
    try {
      const done = await confirmPayment(token, sessionId, { authorizationToken: auth.token, expectedAmount: session.amount })
      setReceipt(done)
      setSession((s) => ({ ...s, status: 'PAID' }))
      setStep('paid')
    } catch (err) {
      const known = err instanceof ApiError && err.code && CONFIRM_ERRORS[err.code]
      if (known) {
        restart()
        setNotice(CONFIRM_ERRORS[err.code])
        load()
      } else if (err instanceof ApiError && err.status === 409) {
        restart()
        load()
      } else {
        setStep('authorized') // network / server trouble: the ticket is still valid, let them retry
        setConfirmError(
          err.status === 0 ? 'Cannot reach the server. Your payment was not confirmed; check your connection and try again.'
            : err.status === 429 ? 'Too many requests. Wait a moment and try again.'
            : err.status >= 500 ? 'Something went wrong on our side. Your payment was not confirmed; please try again.' : err.message,
        )
      }
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">FacePay Checkout</h1>
        <Alert tone="error">{loadError.message}</Alert>
        <div className="flex gap-3">
          {!loadError.notFound && <Button onClick={load}>Try again</Button>}
          <Link className="self-center text-sm font-semibold text-brand-600" to={DASHBOARD_PATH[role]}>Back to dashboard</Link>
        </div>
      </div>
    )
  }
  if (!session) {
    return <div className="flex justify-center py-16"><Spinner label="Loading checkout" /></div>
  }

  if (step === 'paid' && receipt) {
    return (
      <div className="flex flex-col gap-4">
        <Receipt receipt={receipt}>
          <Link className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white" to={RECEIPT_PATH.customer(receipt.transaction_id)}>View transaction</Link>
          <Link className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700" to={DASHBOARD_PATH.customer}>Back to dashboard</Link>
        </Receipt>
      </div>
    )
  }

  const payable = isPayable(session.status)
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight">FacePay Checkout</h1>

      <section aria-label="Payment summary" className="rounded-2xl border border-slate-200 bg-white p-5">
        <dl>
          <Row label="Merchant">{session.merchant_name}</Row>
          <Row label="Order">{session.order_reference ?? '—'}</Row>
          {session.description && <Row label="Details">{session.description}</Row>}
          <Row label="Amount"><span className="text-lg font-bold">{formatMoney(session.amount, session.currency)}</span></Row>
          <Row label="Payment method">FacePay (simulated)</Row>
          <Row label="Status"><StatusBadge status={session.status} /></Row>
          {session.expires_at && payable && <Row label="Session expires">{formatDateTime(session.expires_at)}</Row>}
        </dl>
      </section>

      {notice && <Alert tone="error">{notice}</Alert>}

      {!payable && (
        <>
          <Alert tone={session.status === 'PAID' ? 'info' : 'error'}>{TERMINAL_MESSAGES[session.status] ?? 'This payment cannot be paid.'}</Alert>
          <Link className="text-sm font-semibold text-brand-600" to={DASHBOARD_PATH.customer}>Back to dashboard</Link>
        </>
      )}

      {payable && step === 'summary' && (
        <div className="flex flex-col gap-2">
          <Button onClick={() => { setNotice(null); setStep('authenticating') }}>Pay with FacePay</Button>
          <p className="text-xs text-slate-500">
            You will look at the camera and turn your head, then confirm the amount. {session.attempts_remaining} of {session.max_auth_attempts} face
            attempts left for this payment.
          </p>
        </div>
      )}

      {payable && step === 'authenticating' && (
        <div className="flex flex-col gap-3">
          <FaceAuthFlow
            requestChallenge={() => startPaymentAuth(token, sessionId)}
            verify={(payload, opts) => authenticateForPayment(token, sessionId, payload, opts)}
            onOutcome={onOutcome}
            onError={onAuthError}
          />
          <Button variant="secondary" onClick={restart}>Back</Button>
        </div>
      )}

      {payable && (step === 'authorized' || step === 'processing') && auth && outcome && (
        <Authorized
          session={session}
          auth={auth}
          outcome={outcome}
          busy={step === 'processing'}
          error={confirmError}
          onConfirm={confirm}
          onRestart={restart}
        />
      )}
    </div>
  )
}
