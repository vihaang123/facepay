import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { NumberVerify, PasscodeField } from '../components/numberAuth'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import AuthLayout from '../layouts/AuthLayout'
import { formatMobile, validatePasscode } from '../utils/mobile'
import { DASHBOARD_PATH } from '../utils/roles'

const WELCOME_PATH = '/welcome'

function Details({ verified, initialKind }) {
  const { signUpWithNumber } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [kind, setKind] = useState(initialKind)
  const [values, setValues] = useState({ name: '', business_name: '', passcode: '', confirm: '' })
  const [agreed, setAgreed] = useState(false)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const set = (name) => (e) => setValues((v) => ({ ...v, [name]: name === 'passcode' || name === 'confirm' ? e.target.value.replace(/\D/g, '') : e.target.value }))

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    const found = {}
    if (!values.name.trim()) found.name = 'Name is required'
    if (kind === 'merchant' && !values.business_name.trim()) found.business_name = 'Enter your shop or business name.'
    const weak = validatePasscode(values.passcode)
    if (weak) found.passcode = weak
    else if (values.confirm !== values.passcode) found.confirm = 'The passcodes do not match.'
    if (!agreed) found.agreed = 'Agree to continue.'
    setErrors(found)
    if (Object.keys(found).length) return

    setSubmitting(true)
    try {
      // Signing up signs the person in, and the guest route then sends signed-in people on. Tell it where to: customers carry
      // on to pick a bank and set up their face, shops go to their dashboard.
      navigate(`${location.pathname}${location.search}`, { replace: true, state: { from: { pathname: kind === 'merchant' ? DASHBOARD_PATH.merchant : WELCOME_PATH } } })
      await signUpWithNumber({
        challenge_id: verified.challengeId,
        account_type: kind,
        name: values.name.trim(),
        business_name: kind === 'merchant' ? values.business_name.trim() : undefined,
        passcode: values.passcode,
        agreed,
      })
    } catch (error) {
      setFormError(error.message)
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Alert tone="success"><strong>{formatMobile(verified.mobile)}</strong> confirmed (demo code).</Alert>
      {formError && <Alert tone="error">{formError}</Alert>}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">I am opening a</legend>
        <div className="grid grid-cols-2 gap-2">
          {[['customer', 'Personal account'], ['merchant', 'Shop account']].map(([value, label]) => (
            <label key={value} className={`flex min-h-12 cursor-pointer items-center justify-center rounded-xl border px-3 text-sm font-semibold transition ${kind === value ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface hover:border-line-strong'}`}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} className="sr-only" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <FormField label="Full name" id="name" autoComplete="name" value={values.name} onChange={set('name')} error={errors.name} />
      {kind === 'merchant' && (
        <FormField label="Shop or business name" id="business_name" autoComplete="organization" value={values.business_name} onChange={set('business_name')} error={errors.business_name} />
      )}
      <PasscodeField
        label="Choose a 6-digit passcode"
        autoComplete="new-password"
        hint="You sign in with your number and this passcode. It is not your bank PIN, and nothing here asks for one."
        value={values.passcode}
        onChange={set('passcode')}
        error={errors.passcode}
      />
      <PasscodeField id="confirm" label="Confirm passcode" autoComplete="new-password" value={values.confirm} onChange={set('confirm')} error={errors.confirm} />
      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-3 text-sm text-muted">
          <input
            type="checkbox"
            id="agree"
            checked={agreed}
            aria-invalid={errors.agreed ? 'true' : undefined}
            aria-describedby={errors.agreed ? 'agree-error' : undefined}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-field accent-brand-700"
          />
          <span>
            I understand FacePay is a simulated prototype: no real money moves. My face data is used to verify my payments, and to let shops find me only if I turn that on.
          </span>
        </label>
        {errors.agreed && <p id="agree-error" className="text-xs text-danger-ink">{errors.agreed}</p>}
      </div>
      <Button type="submit" loading={submitting} size="lg">Create account</Button>
    </form>
  )
}

/** Sign up: number, demo code, then name and passcode. Customers carry on to choose a bank and set up their face. */
export default function Start() {
  const [params] = useSearchParams()
  const [verified, setVerified] = useState(null)
  const initialKind = params.get('as') === 'shop' ? 'merchant' : 'customer'
  return (
    <AuthLayout
      title={verified ? 'Set up your account' : 'Get started'}
      subtitle={verified ? undefined : 'Confirm your mobile number to begin.'}
      footer={<>Already on FacePay? <Link to="/login" className="font-semibold text-brand-700">Sign in</Link></>}
    >
      {verified ? <Details verified={verified} initialKind={initialKind} /> : <NumberVerify purpose="signup" onVerified={setVerified} />}
    </AuthLayout>
  )
}
