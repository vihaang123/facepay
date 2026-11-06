import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import AuthLayout from '../layouts/AuthLayout'
import { DASHBOARD_PATH } from '../utils/roles'
import { runValidators, validateEmail, validatePassword, validatePhone, validateRequired } from '../utils/validation'

const CONFIG = {
  customer: {
    title: 'Create your account',
    subtitle: 'Register as a customer. You can set up face recognition after signing in.',
    initial: { name: '', email: '', phone: '', password: '', confirm: '' },
    footer: (
      <>
        Already registered? <Link to="/login" className="font-semibold text-brand-700">Sign in</Link>
      </>
    ),
    payload: (v) => ({ name: v.name.trim(), email: v.email.trim(), phone: v.phone.trim() || null, password: v.password }),
  },
  merchant: {
    title: 'Create a merchant account',
    subtitle: 'Register your business to accept simulated FacePay payments.',
    initial: { name: '', business_name: '', email: '', password: '', confirm: '' },
    footer: (
      <>
        Already registered? <Link to="/merchant/login" className="font-semibold text-brand-700">Sign in</Link>
      </>
    ),
    payload: (v) => ({
      name: v.name.trim(),
      business_name: v.business_name.trim(),
      email: v.email.trim(),
      password: v.password,
    }),
  },
}

export default function Register({ role }) {
  const { register } = useAuth()
  const navigate = useNavigate()
  const cfg = CONFIG[role]
  const [values, setValues] = useState(cfg.initial)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [consentError, setConsentError] = useState(null)

  const onChange = (e) => setValues((v) => ({ ...v, [e.target.name]: e.target.value }))

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    const validators = {
      name: validateRequired('Name'),
      email: validateEmail,
      password: validatePassword,
      confirm: (v, all) => (v === all.password ? null : 'Passwords do not match'),
    }
    if (role === 'customer') validators.phone = validatePhone
    else validators.business_name = validateRequired('Business name')

    const found = runValidators(values, validators)
    setErrors(found)
    if (!agreed) setConsentError('Agree to continue.')
    if (Object.keys(found).length || !agreed) return

    setSubmitting(true)
    try {
      await register(role, cfg.payload(values))
      navigate(DASHBOARD_PATH[role], { replace: true })
    } catch (error) {
      if (Object.keys(error.fieldErrors || {}).length) setErrors(error.fieldErrors)
      setFormError(error.message)
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout title={cfg.title} subtitle={cfg.subtitle} footer={cfg.footer}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {formError && <Alert tone="error">{formError}</Alert>}
        <FormField label="Full name" id="name" autoComplete="name" value={values.name} onChange={onChange} error={errors.name} />
        {role === 'merchant' && (
          <FormField
            label="Business name"
            id="business_name"
            autoComplete="organization"
            value={values.business_name}
            onChange={onChange}
            error={errors.business_name}
          />
        )}
        <FormField label="Email" id="email" type="email" autoComplete="email" value={values.email} onChange={onChange} error={errors.email} />
        {role === 'customer' && (
          <FormField
            label="Phone (optional)"
            id="phone"
            type="tel"
            autoComplete="tel"
            value={values.phone}
            onChange={onChange}
            error={errors.phone}
          />
        )}
        <FormField
          label="Password"
          id="password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters, with a letter and a number."
          value={values.password}
          onChange={onChange}
          error={errors.password}
        />
        <FormField
          label="Confirm password"
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={values.confirm}
          onChange={onChange}
          error={errors.confirm}
        />
        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-3 text-sm text-muted">
            <input
              type="checkbox"
              id="agree"
              checked={agreed}
              aria-invalid={consentError ? 'true' : undefined}
              aria-describedby={consentError ? 'agree-error' : undefined}
              onChange={(e) => {
                setAgreed(e.target.checked)
                if (e.target.checked) setConsentError(null)
              }}
              className="mt-0.5 h-5 w-5 shrink-0 rounded border-field accent-brand-700"
            />
            <span>
              I understand FacePay is a simulated prototype: no real money moves. My face data is used to verify my payments, and to let shops find me only if I turn that on.
            </span>
          </label>
          {consentError && (
            <p id="agree-error" className="text-xs text-danger-ink">
              {consentError}
            </p>
          )}
        </div>
        <Button type="submit" loading={submitting} size="lg">
          Create account
        </Button>
      </form>
    </AuthLayout>
  )
}
