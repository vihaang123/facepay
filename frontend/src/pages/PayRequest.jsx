import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { Alert, Avatar, Button, Card, EmptyState, ErrorState, FeedSkeleton, FormField, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getNearby } from '../services/payments'
import { formatFeedTime, formatMoney } from '../utils/format'
import { sessionIdFrom } from '../utils/paymentLink'
import { CHECKOUT_PATH, SCAN_PATH } from '../utils/roles'

/** Open requests that merchants chose to display. This list is a demo: it uses no location, it is not automatic detection. */
function NearbyDemo() {
  const { token } = useAuth()
  const state = useLoad(() => getNearby(token), [token])
  return (
    <Card
      title="FacePay nearby (demo)"
      aria-label="FacePay nearby demo"
      action={<button type="button" onClick={state.reload} className="text-sm font-semibold text-brand-700 underline-offset-2 hover:underline">Refresh</button>}
    >
      <p className="mb-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">
        Simulated discovery. FacePay does not use your location or detect merchants on its own. These are open payment requests that merchants chose to show here.
      </p>
      {state.loading ? (
        <FeedSkeleton label="Looking for merchant requests" rows={2} />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : state.data.length === 0 ? (
        <EmptyState title="Nothing to show right now" icon="nearby">
          When a merchant displays a payment request, it appears here. You can always paste a payment link instead.
        </EmptyState>
      ) : (
        <ul aria-label="Nearby merchant requests" className="divide-y divide-slate-100">
          {state.data.map((r) => (
            <li key={r.session_id}>
              <Link to={CHECKOUT_PATH(r.session_id)} className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-slate-50 active:bg-slate-100">
                <Avatar name={r.merchant_name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{r.merchant_name}</p>
                  <p className="truncate text-xs text-slate-600">{r.order_reference ?? 'Payment request'}{r.expires_at ? ` · expires ${formatFeedTime(r.expires_at)}` : ''}</p>
                </div>
                <span className="amount shrink-0 font-extrabold">{formatMoney(r.amount, r.currency)}</span>
                <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function PayRequest() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [error, setError] = useState(null)

  const submit = (e) => {
    e.preventDefault()
    const id = sessionIdFrom(text)
    if (!id) {
      setError('That does not look like a FacePay payment link. Paste the full link the merchant shared.')
      return
    }
    navigate(CHECKOUT_PATH(id))
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <PageHeader title="Pay a merchant" subtitle="Open a payment request from a merchant. You see who you are paying and how much before your face is scanned." />
      <Card title="Payment link" aria-label="Payment link">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormField
            label="Payment link"
            id="payment-link"
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null) }}
            error={error}
            hint="For example https://…/checkout/ps_…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <Button type="submit" size="lg" disabled={!text.trim()}>
            <Icon name="arrow" className="h-4 w-4" />Open payment
          </Button>
        </form>
        <p className="mt-3 text-center text-sm"><Link className="font-semibold text-brand-700 underline-offset-2 hover:underline" to={SCAN_PATH}>Scan a payment QR code instead</Link></p>
      </Card>
      <NearbyDemo />
      <Alert tone="info">FacePay never picks a merchant from your face. The merchant and amount always come from a request you open.</Alert>
      <p className="text-center text-xs text-slate-600">Payments here are simulated. No real money moves.</p>
    </div>
  )
}
