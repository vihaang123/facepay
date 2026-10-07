import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { createPaymentSession } from '../services/payments'
import { DASHBOARD_PATH, MERCHANT_SESSION_PATH } from '../utils/roles'
import { validatePayment } from '../utils/validation'

export default function CreatePayment() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ amount: '', orderReference: '', description: '', expiresInMinutes: '15' })
  const [errors, setErrors] = useState({})
  const [submitError, setSubmitError] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const found = validatePayment(form)
    setErrors(found)
    setSubmitError(null)
    if (Object.keys(found).length) return
    setBusy(true)
    try {
      const s = await createPaymentSession(token, {
        amount: form.amount.trim(),
        orderReference: form.orderReference.trim(),
        description: form.description.trim(),
        expiresInMinutes: Number(form.expiresInMinutes),
      })
      navigate(MERCHANT_SESSION_PATH(s.session_id))
    } catch (err) {
      const fe = err.fieldErrors ?? {}
      setErrors({ amount: fe.amount, orderReference: fe.order_reference })
      setSubmitError(err.status === 0 ? err.message : err.status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message)
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Create a payment</h1>
        <p className="mt-1 text-sm text-slate-600">Creates a checkout link for one customer. Simulated payment: no real money moves.</p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5">
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <FormField id="amount" label="Amount (INR)" inputMode="decimal" value={form.amount} onChange={set('amount')} error={errors.amount} placeholder="950.00" />
        <FormField id="orderReference" label="Order / reference" value={form.orderReference} onChange={set('orderReference')} error={errors.orderReference} placeholder="SG-10492" />
        <FormField id="description" label="Description (optional)" value={form.description} onChange={set('description')} maxLength={255} />
        <div className="flex flex-col gap-1">
          <label htmlFor="expiresInMinutes" className="text-sm font-medium text-slate-700">Link valid for</label>
          <select id="expiresInMinutes" value={form.expiresInMinutes} onChange={set('expiresInMinutes')} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            {[5, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy}>Create payment session</Button>
          <Link className="text-sm font-semibold text-slate-600" to={DASHBOARD_PATH.merchant}>Cancel</Link>
        </div>
      </form>
    </div>
  )
}
