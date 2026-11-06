import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { MobileField, PasscodeField } from '../components/numberAuth'
import { Alert, Button } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import AuthLayout from '../layouts/AuthLayout'
import { normalizeMobile, validateMobile } from '../utils/mobile'
import { DASHBOARD_PATH } from '../utils/roles'

/** One sign-in for everyone: your mobile number and your 6-digit passcode. The server says whether you are a customer, a shop or the administrator. */
export default function SignIn() {
  const { signInWithNumber, sessionExpired } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [values, setValues] = useState({ mobile: '', passcode: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const onChange = (e) => setValues((v) => ({ ...v, [e.target.name]: e.target.value }))

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    const found = {}
    const mobileProblem = validateMobile(values.mobile)
    if (mobileProblem) found.mobile = mobileProblem
    if (!values.passcode) found.passcode = 'Enter your 6-digit passcode.'
    setErrors(found)
    if (Object.keys(found).length) return

    setSubmitting(true)
    try {
      const role = await signInWithNumber(normalizeMobile(values.mobile), values.passcode)
      navigate(location.state?.from?.pathname || DASHBOARD_PATH[role], { replace: true })
    } catch (error) {
      setFormError(error.message)
      setSubmitting(false)
    }
  }

  const footer = (
    <>
      New to FacePay? <Link to="/start" className="font-semibold text-brand-700">Get started</Link>
      {' · '}
      <Link to="/start?as=shop" className="font-semibold text-brand-700">Open a shop account</Link>
      <br />
      <Link to="/login/email" className="text-sm font-semibold text-brand-700">Older account? Sign in with email</Link>
    </>
  )

  return (
    <AuthLayout title="Sign in" subtitle="Use the mobile number you registered with FacePay." footer={footer}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {sessionExpired && !formError && <Alert tone="info"><strong>Your session has expired.</strong> Sign in again to continue.</Alert>}
        {formError && <Alert tone="error">{formError}</Alert>}
        <MobileField value={values.mobile} onChange={onChange} error={errors.mobile} />
        <PasscodeField
          label="6-digit passcode"
          hint="The passcode you chose when you joined. Payments still need your face."
          value={values.passcode}
          onChange={(e) => onChange({ target: { name: 'passcode', value: e.target.value.replace(/\D/g, '') } })}
          error={errors.passcode}
        />
        <Button type="submit" loading={submitting} size="lg">Sign in</Button>
        <p className="text-center text-xs text-muted">Forgot your passcode? Passcode recovery is not available in this prototype yet.</p>
      </form>
    </AuthLayout>
  )
}
