import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { requestOtp, verifyOtp } from '../services/numberAuth'
import { formatMobile, normalizeMobile, validateMobile } from '../utils/mobile'
import { Alert, Button, FormField } from './ui'

/** +91 and the number in one field, like the UPI apps. Paste works with spaces, dashes and +91. */
export function MobileField({ id = 'mobile', label = 'Mobile number', error, hint, ...props }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-fg">{label}</label>
      <div className={`flex min-h-12 items-stretch overflow-hidden rounded-xl border bg-surface focus-within:border-brand-700 ${error ? 'border-danger' : 'border-field'}`}>
        <span aria-hidden="true" className="flex items-center border-r border-line bg-sunken px-3 text-base font-semibold text-fg">+91</span>
        <input
          id={id}
          name={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder="98765 43210"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className="min-w-0 flex-1 bg-transparent px-3 text-base placeholder:text-subtle focus:outline-none"
          {...props}
        />
      </div>
      {error ? <p id={`${id}-error`} className="text-xs text-danger-ink">{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

/** Six digits, masked like a PIN, with the usual show/hide. */
export function PasscodeField({ id = 'passcode', label = 'Passcode', autoComplete = 'current-password', ...props }) {
  return <FormField label={label} id={id} type="password" inputMode="numeric" maxLength={6} autoComplete={autoComplete} {...props} />
}

/** The demo one-time code, shown on screen and plainly labelled: FacePay sends no SMS and the code proves nothing about the SIM. */
export function DemoCode({ code }) {
  return (
    <div role="status" aria-label="Demo one-time code" className="rounded-2xl border border-warning-line bg-warning-soft px-4 py-3 text-warning-ink">
      <p className="text-xs font-semibold">Demo code (no SMS is sent)</p>
      <p className="mt-1 font-mono text-3xl font-bold tracking-[0.35em]" aria-label={`Code ${[...code].join(' ')}`}>{code}</p>
      <p className="mt-1 text-xs">FacePay is a prototype and cannot send text messages, so the code is shown here. It does not prove this number is yours.</p>
    </div>
  )
}

function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds)
  useEffect(() => {
    if (left <= 0) return undefined
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  return [left, setLeft]
}

/**
 * Number, then the demo code. Calls onVerified({ mobile, challengeId }) once the code is right.
 * `purpose` is "signup" or "claim" (an older account adding its number).
 */
export function NumberVerify({ purpose = 'signup', onVerified, submitLabel = 'Continue' }) {
  const [number, setNumber] = useState('')
  const [numberError, setNumberError] = useState(null)
  const [challenge, setChallenge] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [registered, setRegistered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useCountdown(0)

  const mobile = normalizeMobile(number)

  const ask = async (e) => {
    e?.preventDefault()
    setError(null)
    setRegistered(false)
    const problem = validateMobile(number)
    setNumberError(problem)
    if (problem) return
    setBusy(true)
    try {
      const made = await requestOtp(mobile, purpose)
      setChallenge(made)
      setCode('')
      setWait(made.resend_in ?? 30)
    } catch (err) {
      if (err.code === 'NUMBER_REGISTERED') setRegistered(true)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const check = async (e) => {
    e.preventDefault()
    setError(null)
    if (!/^[0-9]{6}$/.test(code)) {
      setError('Enter the 6-digit code.')
      return
    }
    setBusy(true)
    try {
      await verifyOtp(challenge.challenge_id, code)
      onVerified({ mobile, challengeId: challenge.challenge_id })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (!challenge) {
    return (
      <form onSubmit={ask} noValidate className="flex flex-col gap-4">
        {error && (
          <Alert tone="error">
            {error}
            {registered && purpose === 'signup' && <> <Link to="/login" className="font-semibold underline">Sign in</Link></>}
          </Alert>
        )}
        <MobileField
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          error={numberError}
          hint="Enter the mobile number linked to your bank account. FacePay is a prototype: it does not check this with any bank."
        />
        <Button type="submit" size="lg" loading={busy}>{submitLabel}</Button>
      </form>
    )
  }

  return (
    <form onSubmit={check} noValidate className="flex flex-col gap-4">
      <p className="text-sm">Enter the code for <strong>{formatMobile(mobile)}</strong>.</p>
      {challenge.demo_code && <DemoCode code={challenge.demo_code} />}
      {error && <Alert tone="error">{error}</Alert>}
      <FormField
        label="6-digit code"
        id="otp"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <Button type="submit" size="lg" loading={busy}>Verify</Button>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => { setChallenge(null); setError(null) }} disabled={busy}>Change number</Button>
        <Button variant="ghost" onClick={ask} disabled={busy || wait > 0}>{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</Button>
      </div>
    </form>
  )
}
