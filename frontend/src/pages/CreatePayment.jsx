import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, ButtonLink, Card, FormField, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { createPaymentSession } from '../services/payments'
import { DASHBOARD_PATH, MERCHANT_SESSION_PATH } from '../utils/roles'
import { validatePayment } from '../utils/validation'

export default function CreatePayment() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ amount: '', orderReference: '', description: '', expiresInMinutes: '15', discoverable: false })
  const [errors, setErrors] = useState({})
  const [submitError, setSubmitError] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const toggle = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }))

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
        discoverable: form.discoverable,
      })
      navigate(MERCHANT_SESSION_PATH(s.session_id))
    } catch (err) {
      const fe = err.fieldErrors ?? {}
      setErrors({ amount: fe.amount, orderReference: fe.order_reference })
      setSubmitError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <PageHeader title="New payment request" subtitle="Creates a secure payment link for one amount and one order. Simulated payment: no real money moves." />
      <Card>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {submitError && <Alert tone="error">{submitError}</Alert>}
          <FormField id="amount" label="Amount (₹)" inputMode="decimal" value={form.amount} onChange={set('amount')} error={errors.amount} placeholder="950.00" />
          <FormField id="orderReference" label="Order / reference" value={form.orderReference} onChange={set('orderReference')} error={errors.orderReference} placeholder="SG-10492" />
          <FormField id="description" label="Description (optional)" value={form.description} onChange={set('description')} maxLength={255} />
          <div className="flex flex-col gap-1">
            <label htmlFor="expiresInMinutes" className="text-sm font-semibold text-fg">Link valid for</label>
            <select id="expiresInMinutes" value={form.expiresInMinutes} onChange={set('expiresInMinutes')} className="min-h-12 rounded-xl border border-field bg-surface px-3.5 text-base">
              {[5, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3.5">
            <input type="checkbox" checked={form.discoverable} onChange={toggle('discoverable')} className="mt-0.5 h-4 w-4 accent-brand-700" />
            <span className="text-sm">
              <span className="block font-semibold">Show in FacePay nearby (demo)</span>
              <span className="block text-muted">Lists this request for signed-in customers in the simulated nearby view. You can hide it again at any time. Customers can always pay from the link.</span>
            </span>
          </label>
          <div className="flex flex-col gap-2">
            <Button type="submit" loading={busy} size="lg">Create payment request</Button>
            <ButtonLink to={DASHBOARD_PATH.merchant} variant="ghost">Cancel</ButtonLink>
          </div>
        </form>
      </Card>
    </div>
  )
}
