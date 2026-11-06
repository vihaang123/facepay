import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import FaceFinder from '../components/FaceFinder'
import { PersonCard } from '../components/money'
import { Row, SimulatedTag } from '../components/payUi'
import RecipientPicker from '../components/RecipientPicker'
import RequestDetails from '../components/RequestDetails'
import { ButtonLink } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { createRequest } from '../services/transfers'
import { formatDateTime, formatMoney } from '../utils/format'
import { REQUESTS_PATH } from '../utils/roles'

function Sent({ request }) {
  return (
    <section aria-label="Request sent" className="flex flex-col gap-4 rounded-3xl border border-line/80 bg-surface p-6 text-center shadow-card">
      <h2 className="text-xl font-bold">Request sent</h2>
      <p className="amount text-4xl font-bold">{formatMoney(request.amount, request.currency)}</p>
      <p className="text-sm text-fg">{request.counterparty_name} gets it as a pop-up in FacePay and sees it under Requests. Nothing has been taken from anyone; they choose whether to pay, with their own face check.</p>
      <dl className="text-left">
        <Row label="From">{request.counterparty_name}</Row>
        <Row label="For">{request.purpose_label}</Row>
        <Row label="Reference">{request.note}</Row>
        <Row label="Status">Pending</Row>
        <Row label="Expires">{formatDateTime(request.expires_at)}</Row>
      </dl>
      <SimulatedTag className="mx-auto" />
      <ButtonLink to={REQUESTS_PATH} size="lg">View requests</ButtonLink>
    </section>
  )
}

function DetailsStep({ payer, onBack, onSent }) {
  const { token } = useAuth()
  const submit = async ({ amount, purpose, reference }) => {
    onSent(await createRequest(token, { payer: payer.id, lookupToken: payer.lookupToken, amount, purpose, note: reference }))
  }
  return (
    <div className="flex flex-col gap-5">
      <PersonCard name={payer.display_name} maskedId={payer.masked_id} caption="Requesting from" />
      <RequestDetails onSubmit={submit} onBack={onBack} />
    </div>
  )
}

function PickPerson({ initialId, onPick }) {
  const [mode, setMode] = useState(initialId ? 'id' : 'face')
  const tab = (key, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === key}
      onClick={() => setMode(key)}
      className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-semibold transition ${mode === key ? 'bg-surface text-brand-800 shadow-sm' : 'text-fg'}`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="How to find the person" className="flex gap-1 rounded-xl bg-sunken p-1">
        {tab('face', 'Scan their face')}
        {tab('id', 'FacePay ID')}
      </div>
      {mode === 'face' ? (
        <FaceFinder
          actionLabel="Continue"
          onFound={({ lookupToken, person }) => onPick({ lookupToken, display_name: person.display_name, masked_id: person.masked_id })}
        />
      ) : (
        <RecipientPicker onPick={onPick} initial={initialId} prompt="Who should pay you?" actionLabel="Continue" />
      )}
    </div>
  )
}

export default function RequestMoney() {
  const [params] = useSearchParams()
  const [payer, setPayer] = useState(null)
  const [sent, setSent] = useState(null)
  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Request money</h1>
        <p className="mt-1 text-sm text-muted">Ask another FacePay customer to pay you, and say what it is for. They approve it themselves.</p>
      </div>
      {sent ? <Sent request={sent} /> : payer ? <DetailsStep payer={payer} onBack={() => setPayer(null)} onSent={setSent} /> : (
        <PickPerson initialId={params.get('from') ?? ''} onPick={setPayer} />
      )}
      {!sent && <p className="text-center text-sm"><Link className="font-semibold text-brand-700 underline" to={REQUESTS_PATH}>See your requests</Link></p>}
    </div>
  )
}
