import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { SECURITY_PATH } from '../utils/roles'
import { runValidators, validatePhone, validateRequired } from '../utils/validation'

export default function Profile() {
  const { role, profile, updateProfile } = useAuth()
  const isMerchant = role === 'merchant'
  const [values, setValues] = useState({
    name: profile.name,
    phone: profile.phone || '',
    business_name: profile.business_name || '',
  })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const onChange = (e) => {
    setSaved(false)
    setValues((v) => ({ ...v, [e.target.name]: e.target.value }))
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    setSaved(false)
    const validators = { name: validateRequired('Name') }
    if (isMerchant) validators.business_name = validateRequired('Business name')
    else validators.phone = validatePhone
    const found = runValidators(values, validators)
    setErrors(found)
    if (Object.keys(found).length) return

    const changes = isMerchant
      ? { name: values.name.trim(), business_name: values.business_name.trim() }
      : { name: values.name.trim(), phone: values.phone.trim() || null }

    setSubmitting(true)
    try {
      await updateProfile(changes)
      setSaved(true)
    } catch (error) {
      if (Object.keys(error.fieldErrors || {}).length) setErrors(error.fieldErrors)
      setFormError(error.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-extrabold tracking-tight">Profile</h1>
      <p className="mt-1 text-sm text-slate-600">
        Joined {new Date(profile.created_at).toLocaleDateString()}
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-6 shadow-card">
        {formError && <Alert tone="error">{formError}</Alert>}
        {saved && <Alert tone="success">Profile updated.</Alert>}
        <FormField label="Email" id="email" value={profile.email} disabled hint="Email cannot be changed." readOnly />
        <FormField label="Full name" id="name" value={values.name} onChange={onChange} error={errors.name} />
        {isMerchant ? (
          <FormField
            label="Business name"
            id="business_name"
            value={values.business_name}
            onChange={onChange}
            error={errors.business_name}
          />
        ) : (
          <FormField label="Phone" id="phone" type="tel" value={values.phone} onChange={onChange} error={errors.phone} />
        )}
        <Button type="submit" loading={submitting} className="self-start">
          Save changes
        </Button>
      </form>
      {!isMerchant && (
        <p className="mt-4 text-sm text-slate-700">
          Looking for face payment controls, your payment PIN or recent activity? Open <Link className="font-semibold text-brand-800 underline" to={SECURITY_PATH}>Security</Link>.
        </p>
      )}
    </div>
  )
}
