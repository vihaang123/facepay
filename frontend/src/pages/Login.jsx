import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import AuthLayout from '../layouts/AuthLayout'
import { DASHBOARD_PATH } from '../utils/roles'
import { runValidators, validateEmail, validateRequired } from '../utils/validation'

const COPY = {
  customer: {
    title: 'Sign in with email',
    subtitle: 'For accounts made before FacePay moved to mobile numbers. Sign in, then add your number from Profile.',
    footer: (
      <>
        <Link to="/login" className="font-semibold text-brand-700">Sign in with your mobile number</Link>
        {' · '}
        <Link to="/merchant/login" className="font-semibold text-brand-700">Shop email sign in</Link>
      </>
    ),
  },
  merchant: {
    title: 'Shop sign in with email',
    subtitle: 'For shop accounts made before FacePay moved to mobile numbers. Sign in, then add your number from Profile.',
    footer: (
      <>
        <Link to="/login" className="font-semibold text-brand-700">Sign in with your mobile number</Link>
        {' · '}
        <Link to="/login/email" className="font-semibold text-brand-700">Customer email sign in</Link>
      </>
    ),
  },
}

export default function Login({ role }) {
  const { login, sessionExpired } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [values, setValues] = useState({ email: '', password: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const copy = COPY[role]

  const onChange = (e) => setValues((v) => ({ ...v, [e.target.name]: e.target.value }))

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    const found = runValidators(values, { email: validateEmail, password: validateRequired('Password') })
    setErrors(found)
    if (Object.keys(found).length) return

    setSubmitting(true)
    try {
      await login(role, values.email.trim(), values.password)
      navigate(location.state?.from?.pathname || DASHBOARD_PATH[role], { replace: true })
    } catch (error) {
      setFormError(error.message)
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title={copy.title} subtitle={copy.subtitle} footer={copy.footer}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {sessionExpired && !formError && <Alert tone="info"><strong>Your session has expired.</strong> Log in again to continue.</Alert>}
        {formError && <Alert tone="error">{formError}</Alert>}
        <FormField
          label="Email"
          id="email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={onChange}
          error={errors.email}
        />
        <FormField
          label="Password"
          id="password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={onChange}
          error={errors.password}
        />
        <Button type="submit" loading={submitting} size="lg">
          Sign in
        </Button>
        <p className="text-center text-xs text-muted">Forgot your password? Password reset is not available in this prototype yet.</p>
      </form>
    </AuthLayout>
  )
}
