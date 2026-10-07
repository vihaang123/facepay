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
        Already registered? <Link to="/login" className="font-semibold text-brand-600">Sign in</Link>
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
        Already registered? <Link to="/merchant/login" className="font-semibold text-brand-600">Sign in</Link>
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
    if (Object.keys(found).length) return

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
        <Button type="submit" loading={submitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  )
}
