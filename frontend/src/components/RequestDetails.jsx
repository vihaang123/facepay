import { useState } from 'react'
import { Alert, Button, FormField } from './ui'
import { MAX_AMOUNT, toAmountString, validateAmount } from '../utils/money'
import { MAX_REFERENCE, PURPOSES, validatePurpose, validateReference } from '../utils/reference'

/**
 * Amount, purpose and reference for a request. The purpose and the reference are required: they are what the person asked
 * sees first, and they make scam requests harder. onSubmit({ amount, purpose, reference }) may throw an ApiError; its
 * message is shown, and field errors from the server are shown under the field.
 */
export default function RequestDetails({ onSubmit, submitLabel = 'Send request', onBack, backLabel = 'Change person' }) {
  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('')
  const [reference, setReference] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const found = {
      amount: validateAmount(amount, { max: MAX_AMOUNT }),
      purpose: validatePurpose(purpose),
      reference: validateReference(reference),
    }
    setErrors(found)
    setFormError(null)
    if (found.amount || found.purpose || found.reference) return
    setBusy(true)
    try {
      await onSubmit({ amount: toAmountString(amount), purpose, reference: reference.trim().split(/\s+/).join(' ') })
    } catch (err) {
      const fe = err.fieldErrors ?? {}
      setErrors({ amount: fe.amount, purpose: fe.purpose, reference: fe.note ?? fe.order_reference })
      setFormError(err.message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        {formError && <Alert tone="error">{formError}</Alert>}
        <FormField label="Amount (₹)" id="amount" value={amount} onChange={(e) => { setAmount(e.target.value); setErrors((x) => ({ ...x, amount: null })) }} error={errors.amount} inputMode="decimal" autoComplete="off" placeholder="0.00" />
        <div className="flex flex-col gap-1">
          <label htmlFor="purpose" className="text-sm font-semibold text-slate-800">What is this for?</label>
          <select
            id="purpose"
            value={purpose}
            onChange={(e) => { setPurpose(e.target.value); setErrors((x) => ({ ...x, purpose: null })) }}
            aria-invalid={errors.purpose ? 'true' : undefined}
            aria-describedby={errors.purpose ? 'purpose-error' : undefined}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3.5 text-base"
          >
            <option value="">Choose a purpose</option>
            {PURPOSES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
          {errors.purpose && <p id="purpose-error" role="alert" className="text-sm font-medium text-rose-700">{errors.purpose}</p>}
        </div>
        <FormField
          label="Reference"
          id="reference"
          value={reference}
          onChange={(e) => { setReference(e.target.value.slice(0, MAX_REFERENCE)); setErrors((x) => ({ ...x, reference: null })) }}
          maxLength={MAX_REFERENCE}
          error={errors.reference}
          autoComplete="off"
          placeholder="For example: Bill 2231, groceries"
          hint={`Required. The person you ask sees this before they pay. ${reference.length} of ${MAX_REFERENCE}`}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Button size="lg" type="submit" loading={busy}>{submitLabel}</Button>
        {onBack && <Button variant="ghost" onClick={onBack} disabled={busy}>{backLabel}</Button>}
      </div>
    </form>
  )
}
