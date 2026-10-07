import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import AuthLayout from '../layouts/AuthLayout'
import { DASHBOARD_PATH } from '../utils/roles'
import { runValidators, validateEmail, validateRequired } from '../utils/validation'

const COPY = {
  customer: {
    title: 'Customer sign in',
    subtitle: 'Sign in to manage your FacePay profile.',
    footer: (
      <>
        New here? <Link to="/register" className="font-semibold text-brand-700">Create an account</Link>
        {' · '}
        <Link to="/merchant/login" className="font-semibold text-brand-700">Merchant sign in</Link>
      </>
    ),
  },
  merchant: {
    title: 'Merchant sign in',
    subtitle: 'Sign in to your merchant account.',
    footer: (
      <>
        New merchant? <Link to="/merchant/register" className="font-semibold text-brand-700">Create a merchant account</Link>
        {' · '}
        <Link to="/login" className="font-semibold text-brand-700">Customer sign in</Link>
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
        {sessionExpired && !formError && <Alert tone="info">Your session has ended. Please sign in again.</Alert>}
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
        <Button type="submit" loading={submitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
