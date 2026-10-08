import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthDetails, PaymentStages } from '../components/AuthStages'
import Icon from '../components/Icon'
import FaceAuthFlow from '../components/FaceAuthFlow'
import { Amount, MerchantHeader, Row, SecurityNote, SimulatedTag, StatusBadge, Timeline } from '../components/payUi'
import { Alert, Button, ButtonLink, Card, ErrorState, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { ApiError } from '../services/api'
import { authenticateForPayment, confirmPayment, getCheckout, startPaymentAuth } from '../services/payments'
import { DASHBOARD_PATH, RECEIPT_PATH, SECURITY_PATH } from '../utils/roles'
import { formatDateTime, formatMoney, isPayable } from '../utils/format'
import { customerTimeline } from '../utils/timeline'

const TERMINAL_MESSAGES = {
  PAID: 'This payment has already been completed.',
  EXPIRED: 'This payment request has expired. Ask the merchant for a new one.',
  CANCELLED: 'The merchant cancelled this payment request.',
  FAILED: 'Too many failed face checks. Ask the merchant for a new payment request.',
}

// Customer-friendly wording. The server's error code stays available under "Technical details".
const CONFIRM_ERRORS = {
  AUTHORIZATION_EXPIRED: 'Your face check expired. Verify your face again to continue.',
  AUTHORIZATION_INVALID: "We couldn't authorize this payment. Please try again.",
  AUTHORIZATION_USED: "We couldn't authorize this payment. Please try again.",
  AMOUNT_MISMATCH: 'The amount for this payment changed. Please review it and verify your face again.',
  MERCHANT_MISMATCH: 'The merchant for this payment changed. Please review it and verify your face again.',
  ORDER_MISMATCH: 'The order for this payment changed. Please review it and verify your face again.',
  SESSION_ALREADY_PAID: 'This payment was already completed. Check your payment history before paying again.',
}

function describeLoadError(err) {
  return {
    notFound: err.status === 404,
    message:
      err.status === 404 ? 'This payment session does not exist.'
      : err.status === 403 ? 'Only customers can pay. Sign in with a customer account.'
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

function Secured() {
  return (
    <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-600">
      <Icon name="lock" className="h-3.5 w-3.5" />
      Face + basic liveness check, then your confirmation
    </p>
  )
}

const PIN_LENGTH = 6

function Authorized({ session, auth, outcome, error, pinError, busy, onConfirm, onRestart }) {
  const left = useSecondsLeft(auth.expiresAt)
  const [pin, setPin] = useState('')
  const expired = left === 0
  const amount = formatMoney(session.amount, session.currency)
  const needsPin = auth.stepUp
  const pinReady = !needsPin || (auth.pinSet && pin.length === PIN_LENGTH)
  const submit = (e) => {
    e.preventDefault()
    if (pinReady && !busy) onConfirm(needsPin ? pin : undefined)
  }
  return (
    <section aria-label="Confirm payment" className="animate-rise flex flex-col gap-5">
      <div className="rounded-[1.5rem] border border-slate-200/80 bg-white p-6 text-center shadow-card">
        <h2 className="text-sm font-semibold text-slate-600">Confirm payment</h2>
        <Amount value={session.amount} currency={session.currency} className="mt-2 text-5xl" data-testid="confirm-amount" />
        <dl className="mt-5 text-left">
          <Row label="To">{session.merchant_name}</Row>
          <Row label="Order">{session.order_reference ?? '—'}</Row>
          <Row label="Authenticated"><span className="text-emerald-800">Face + basic liveness check</span></Row>
        </dl>
        <SimulatedTag className="mt-3" />
      </div>

      <PaymentStages outcome={outcome} authorized />

      {error && <Alert tone="error">{error}</Alert>}
      {expired ? (
        <div className="flex flex-col gap-3">
          <Alert tone="error">Your face check expired. Verify your face again to continue.</Alert>
          <Button size="lg" onClick={onRestart}>Verify again</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {needsPin && (
            <div className="rounded-xl bg-amber-50 p-4 text-sm ring-1 ring-amber-200">
              <p className="font-semibold text-amber-900">This payment needs your payment PIN</p>
              {auth.stepUpReasons.length > 0 && <p className="mt-1 text-amber-900">Because of {auth.stepUpReasons.join(', ')}.</p>}
              <p className="mt-1 text-xs text-amber-900">Risk-based authorization prototype</p>
              {auth.pinSet ? (
                <div className="mt-3">
                  <label htmlFor="payment-pin" className="block text-sm font-semibold text-slate-900">Payment PIN</label>
                  <input
                    id="payment-pin" name="payment-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_LENGTH}
                    value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                    aria-describedby={pinError ? 'pin-error' : undefined} aria-invalid={pinError ? true : undefined}
                    className="mt-1 w-40 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-center text-xl tracking-[0.4em]"
                  />
                  {pinError && <p id="pin-error" role="alert" className="mt-2 text-sm font-semibold text-rose-800">{pinError}</p>}
                </div>
              ) : (
                <p className="mt-3">
                  You have not set a payment PIN yet. <Link className="font-semibold underline" to={SECURITY_PATH}>Set one in Security</Link>, then verify your face again.
                </p>
              )}
            </div>
          )}
          <Button size="lg" type="submit" disabled={!pinReady} loading={busy}>Confirm payment of {amount}</Button>
          <Button variant="ghost" onClick={onRestart} disabled={busy}>Cancel</Button>
          <p className="text-center text-xs text-slate-600">This authorization is for this payment only, can be used once and stays valid for {clock(left)}.</p>
        </form>
      )}
      <details className="rounded-xl bg-white/70 px-4 py-3 text-sm ring-1 ring-slate-200">
        <summary className="cursor-pointer font-semibold">How FacePay verified you</summary>
        <div className="mt-3 flex flex-col gap-3"><AuthDetails result={outcome} /></div>
      </details>
    </section>
  )
}

/** Shown only while the confirm request is really in flight; it ends when the server answers. */
function Processing({ outcome }) {
  return (
    <section aria-label="Processing payment" className="animate-rise flex flex-col gap-5 rounded-[1.5rem] border border-slate-200/80 bg-white p-8 shadow-card" role="status">
      <h2 className="text-center text-xl font-extrabold">Processing payment</h2>
      <PaymentStages outcome={outcome} authorized confirming />
    </section>
  )
}

function Success({ receipt, session, outcome }) {
  return (
    <section aria-label="Payment successful" className="flex flex-col gap-5">
      <div className="rounded-[1.5rem] border border-slate-200/80 bg-white p-8 text-center shadow-card">
        <span aria-hidden="true" className="mx-auto flex h-20 w-20 motion-safe:animate-pop items-center justify-center rounded-full bg-emerald-600 text-white">
          <Icon name="check" className="h-10 w-10" strokeWidth="2.6" />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold">Payment successful</h1>
        <Amount value={receipt.amount} currency={receipt.currency} className="mt-2 text-5xl" data-testid="paid-amount" />
        <p className="mt-2 text-lg font-bold">{receipt.merchant_name ?? session.merchant_name}</p>
        <p className="mt-3 text-xs text-slate-600">Transaction</p>
        <p className="font-mono text-sm font-semibold">{receipt.transaction_id}</p>
        <p className="mt-3 text-sm font-semibold text-emerald-800">Authenticated: {receipt.authentication ?? 'Face + basic liveness check'}</p>
        <p className="mt-1 text-xs text-slate-600">{formatDateTime(receipt.timestamp)}</p>
        <SimulatedTag className="mt-4" />
      </div>
      <PaymentStages outcome={outcome} authorized paid />
      <div className="flex flex-col gap-2">
        <ButtonLink to={RECEIPT_PATH.customer(receipt.transaction_id)} size="lg">View receipt</ButtonLink>
        <ButtonLink to={DASHBOARD_PATH.customer} variant="secondary" size="lg">Done</ButtonLink>
      </div>
    </section>
  )
}

function Summary({ session, payable, attempts, onPay }) {
  return (
    <section aria-label="Payment summary" className="rounded-[1.5rem] border border-slate-200/80 bg-white p-6 shadow-card">
      <MerchantHeader name={session.merchant_name} />
      <div className="mt-6 text-center">
        <p className="text-sm text-slate-600">Amount to pay</p>
        <Amount value={session.amount} currency={session.currency} className="mt-1 text-6xl" data-testid="checkout-amount" />
        <SimulatedTag className="mt-3" />
      </div>
      <dl className="mt-5">
        <Row label="Order">{session.order_reference ?? '—'}</Row>
        {session.description && <Row label="Details">{session.description}</Row>}
        <Row label="Status"><StatusBadge status={session.status} /></Row>
      </dl>
      {payable && (
        <div className="mt-5 flex flex-col gap-3">
          <p className="text-center text-sm font-semibold">Pay with FacePay</p>
          <Button size="lg" onClick={onPay}><Icon name="face" className="h-5 w-5" />Pay with Face</Button>
          <Secured />
          <p className="text-center text-xs text-slate-600">{attempts}</p>
        </div>
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
  const [pinError, setPinError] = useState(null)
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

  const restart = () => { setAuth(null); setOutcome(null); setConfirmError(null); setPinError(null); setStep('summary') }

  const onOutcome = (result) => {
    setSession((s) => ({ ...s, status: result.session_status, attempts_remaining: result.attempts_remaining }))
    setOutcome(result)
    if (result.result === 'AUTHENTICATED' && result.authorization) {
      const a = result.authorization
      setAuth({
        token: a.authorization_token, expiresAt: a.expires_at,
        stepUp: Boolean(a.step_up_required), stepUpReasons: a.step_up_reasons ?? [], pinSet: Boolean(a.pin_set),
      })
      setConfirmError(null)
      setStep('authorized')
    }
  }

  const onAuthError = (err) => {
    if (err.status === 404 || err.status === 409) load() // the session changed under us: show its real state
  }

  const confirm = async (pin) => {
    setStep('processing')
    setConfirmError(null)
    setPinError(null)
    try {
      const done = await confirmPayment(token, sessionId, {
        authorizationToken: auth.token,
        // Exactly what the customer was shown. The server compares each one with the session and the authorization.
        expectedAmount: session.amount,
        expectedMerchant: session.merchant_name,
        expectedOrderReference: session.order_reference ?? '',
        pin,
      })
      setReceipt(done)
      setSession((s) => ({ ...s, status: 'PAID' }))
      setStep('paid')
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null
      if (code === 'PIN_INCORRECT' || code === 'PIN_REQUIRED') {
        setStep('authorized') // the authorization is still valid; only the PIN needs another try
        setPinError(err.message)
      } else if (code === 'PIN_LOCKED' || code === 'PER_TRANSACTION_LIMIT' || code === 'DAILY_LIMIT_EXCEEDED' || code === 'BIOMETRIC_DISABLED') {
        restart()
        setNotice(err.message)
        load()
      } else if (code && CONFIRM_ERRORS[code]) {
        restart()
        setNotice(CONFIRM_ERRORS[code])
        load()
      } else if (err instanceof ApiError && err.status === 409) {
        restart()
        load()
      } else {
        setStep('authorized') // network / server trouble: the authorization is still valid, let them retry
        setConfirmError(`${err.message} Your payment was not confirmed.`)
      }
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight">Checkout</h1>
        <ErrorState message={loadError.message} onRetry={loadError.notFound ? undefined : load} />
        <ButtonLink to={DASHBOARD_PATH[role]} variant="secondary">Back to home</ButtonLink>
      </div>
    )
  }
  if (!session) {
    return (
      <div role="status" aria-label="Loading checkout" className="mx-auto flex max-w-md flex-col gap-4">
        <Skeleton className="h-72 w-full !rounded-[1.5rem]" />
        <Skeleton className="h-14 w-full !rounded-xl" />
      </div>
    )
  }

  const payable = isPayable(session.status)
  const timeline = customerTimeline({ session, outcome, authorized: step === 'authorized' || step === 'processing' || step === 'paid', receipt })
  const attempts = `${session.attempts_remaining} of ${session.max_auth_attempts} face checks left for this payment.`
  const heading = step === 'authenticating' ? 'Verify your face' : step === 'paid' ? null : 'Checkout'

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      {heading && <h1 className="text-2xl font-extrabold tracking-tight">{heading}</h1>}

      {notice && <Alert tone="error">{notice}</Alert>}

      {step !== 'paid' && (step === 'summary' || !payable) && (
        <Summary session={session} payable={payable && step === 'summary'} attempts={attempts} onPay={() => { setNotice(null); setStep('authenticating') }} />
      )}

      {!payable && step !== 'paid' && (
        <>
          <Alert tone={session.status === 'PAID' ? 'info' : 'error'}>{TERMINAL_MESSAGES[session.status] ?? 'This payment cannot be paid.'}</Alert>
          <ButtonLink to={DASHBOARD_PATH.customer} variant="secondary" size="lg">Back to home</ButtonLink>
        </>
      )}

      {payable && step === 'authenticating' && (
        <>
          <FaceAuthFlow
            requestChallenge={() => startPaymentAuth(token, sessionId)}
            verify={(payload, opts) => authenticateForPayment(token, sessionId, payload, opts)}
            onOutcome={onOutcome}
            onError={onAuthError}
          />
          <Button variant="ghost" onClick={restart} className="self-center">Back to payment</Button>
        </>
      )}

      {step === 'authorized' && auth && outcome && (
        <Authorized session={session} auth={auth} outcome={outcome} error={confirmError} pinError={pinError} onConfirm={confirm} onRestart={restart} />
      )}

      {step === 'processing' && <Processing outcome={outcome} />}

      {step === 'paid' && receipt && <Success receipt={receipt} session={session} outcome={outcome} />}

      <SecurityNote />

      <Card title="Payment timeline" className="!p-5">
        <Timeline steps={timeline} />
      </Card>
    </div>
  )
}
