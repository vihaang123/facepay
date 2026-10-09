import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PersonCard } from '../components/money'
import RecipientPicker from '../components/RecipientPicker'
import { Row, SimulatedTag } from '../components/payUi'
import { Alert, Button, ButtonLink, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { createRequest } from '../services/transfers'
import { formatDateTime, formatMoney } from '../utils/format'
import { MAX_AMOUNT, toAmountString, validateAmount } from '../utils/money'
import { REQUESTS_PATH } from '../utils/roles'

function Sent({ request }) {
  return (
    <section aria-label="Request sent" className="flex flex-col gap-4 rounded-[1.5rem] border border-slate-200/80 bg-white p-6 text-center shadow-card">
      <h2 className="text-xl font-extrabold">Request sent</h2>
      <p className="amount text-4xl font-extrabold">{formatMoney(request.amount, request.currency)}</p>
      <p className="text-sm text-slate-700">{request.counterparty_name} will see it under Requests. Nothing has been taken from anyone; they choose whether to pay.</p>
      <dl className="text-left">
        <Row label="From">{request.counterparty_name}</Row>
        {request.note && <Row label="Note">{request.note}</Row>}
        <Row label="Status">Pending</Row>
        <Row label="Expires">{formatDateTime(request.expires_at)}</Row>
      </dl>
      <SimulatedTag className="mx-auto" />
      <ButtonLink to={REQUESTS_PATH} size="lg">View requests</ButtonLink>
    </section>
  )
}

function AmountStep({ payer, onBack, onSent }) {
  const { token } = useAuth()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const problem = validateAmount(amount, { max: MAX_AMOUNT })
    setError(problem)
    setFormError(null)
    if (problem) return
    setBusy(true)
    try {
      onSent(await createRequest(token, { payer: payer.id, amount: toAmountString(amount), note: note.trim() }))
    } catch (err) {
      if (err.fieldErrors?.amount) setError(err.fieldErrors.amount)
      else setFormError(err.message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <PersonCard name={payer.display_name} maskedId={payer.masked_id} caption="Requesting from" />
      <div className="flex flex-col gap-4 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
        {formError && <Alert tone="error">{formError}</Alert>}
        <FormField label="Amount (₹)" id="amount" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null) }} error={error} inputMode="decimal" autoComplete="off" placeholder="0.00" />
        <FormField label="Note (optional)" id="note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 140))} maxLength={140} autoComplete="off" placeholder="What is it for?" hint={`${note.length} of 140`} />
      </div>
      <div className="flex flex-col gap-2">
        <Button size="lg" type="submit" loading={busy}>Send request</Button>
        <Button variant="ghost" onClick={onBack} disabled={busy}>Change person</Button>
      </div>
    </form>
  )
}

export default function RequestMoney() {
  const [params] = useSearchParams()
  const [payer, setPayer] = useState(null)
  const [sent, setSent] = useState(null)
  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Request money</h1>
        <p className="mt-1 text-sm text-slate-600">Ask another FacePay customer to pay you. They approve it themselves.</p>
      </div>
      {sent ? <Sent request={sent} /> : payer ? <AmountStep payer={payer} onBack={() => setPayer(null)} onSent={setSent} /> : (
        <RecipientPicker onPick={setPayer} initial={params.get('from') ?? ''} prompt="Who should pay you?" actionLabel="Continue" />
      )}
      {!sent && <p className="text-center text-sm"><Link className="font-semibold text-brand-700 underline" to={REQUESTS_PATH}>See your requests</Link></p>}
    </div>
  )
}
