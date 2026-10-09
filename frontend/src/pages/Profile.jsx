import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IdChip } from '../components/money'
import { Alert, Button, Card, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { changeFacePayId, getMyFacePay } from '../services/transfers'
import { formatDateTime } from '../utils/format'
import { FACE_PATH, MY_QR_PATH, SECURITY_PATH } from '../utils/roles'
import { runValidators, validatePhone, validateRequired } from '../utils/validation'

/** The FacePay ID: shown, shareable, and changeable now and then. The server checks it is free and well formed. */
function FacePayIdCard() {
  const { token, profile, refreshProfile } = useAuth()
  const state = useLoad(() => getMyFacePay(token), [token, profile.facepay_id])
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const save = async (e) => {
    e.preventDefault()
    if (!value.trim()) {
      setError('Enter the new ID.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await changeFacePayId(token, value.trim())
      await refreshProfile()
      setEditing(false)
      setValue('')
      setNotice('FacePay ID updated. Your old ID stops working for new payments.')
    } catch (err) {
      setError(err.fieldErrors?.facepay_id ?? err.message)
    } finally {
      setBusy(false)
    }
  }

  const info = state.data
  return (
    <Card title="FacePay ID" className="mt-6" aria-label="FacePay ID">
      <IdChip id={profile.facepay_id} name={profile.name} onNotice={setNotice} size="lg" />
      <p className="mt-2 text-xs text-slate-600">Share this so people can pay or ask you for money. It never shows your email or phone number.</p>
      {notice && <Alert tone="success" className="mt-3">{notice}</Alert>}
      {info && !editing && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => { setEditing(true); setNotice(null) }} disabled={!info.can_change}>Change ID</Button>
          <Link className="text-sm font-semibold text-brand-800 underline" to={MY_QR_PATH}>Show my QR</Link>
          {!info.can_change && info.next_change_at && <p className="w-full text-xs text-slate-600">You can change it again after {formatDateTime(info.next_change_at)}.</p>}
        </div>
      )}
      {editing && (
        <form onSubmit={save} noValidate className="mt-3 flex flex-col gap-3">
          <FormField label="New FacePay ID" id="new-facepay-id" value={value} onChange={(e) => { setValue(e.target.value); setError(null) }} error={error} hint="3 to 24 letters or numbers, with . or _ between them. We add @facepay." autoComplete="off" autoCapitalize="none" spellCheck={false} />
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>Save ID</Button>
            <Button variant="ghost" onClick={() => { setEditing(false); setError(null) }} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  )
}

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
      {!isMerchant && role === 'customer' && <FacePayIdCard />}
      {!isMerchant && (
        <p className="mt-4 text-sm text-slate-700">
          Looking for face payment controls, your payment PIN or recent activity? Open <Link className="font-semibold text-brand-800 underline" to={SECURITY_PATH}>Security</Link>, or set up your face in <Link className="font-semibold text-brand-800 underline" to={FACE_PATH}>Face profile</Link>.
        </p>
      )}
    </div>
  )
}
