import { useParams } from 'react-router-dom'
import { Amount, Row, SimulatedTag, StatusBadge } from '../components/payUi'
import { ReferenceNumber, Trail } from '../components/Trail'
import { Button, ButtonLink, ErrorState, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getActivityDetail } from '../services/transfers'
import { activityTitle } from '../utils/activity'
import { formatDateTime } from '../utils/format'
import { SIMULATION_NOTICE } from '../utils/demo'
import { ACTIVITY_PATH, REQUESTS_PATH } from '../utils/roles'

const KIND = { TRANSFER: 'Sent to a person', MERCHANT_PAYMENT: 'Merchant payment', REQUEST: 'Money request' }

export default function ActivityDetail() {
  const { ref } = useParams()
  const { token } = useAuth()
  const state = useLoad(() => getActivityDetail(token, ref), [token, ref])

  if (state.loading) return <div role="status" aria-label="Loading details" className="mx-auto max-w-md"><Skeleton className="h-96 w-full !rounded-3xl" /></div>
  if (state.error) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <ErrorState title="Could not open this" message={state.error} onRetry={state.reload} />
        <ButtonLink to={ACTIVITY_PATH} variant="secondary">Back to activity</ButtonLink>
      </div>
    )
  }
  const d = state.data
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <article aria-label="Activity details" className="print-card overflow-hidden rounded-3xl border border-line/80 bg-surface shadow-card">
        <div className="bg-sunken px-6 pb-5 pt-6 text-center">
          <p className="text-sm font-semibold text-fg">{activityTitle(d)}</p>
          <Amount value={d.amount} currency={d.currency} className="mt-1 text-4xl" />
          <div className="mt-2 flex justify-center gap-2"><StatusBadge status={d.status} /></div>
          <SimulatedTag className="mt-3" />
        </div>
        <dl className="px-6 py-2">
          <Row label="Type">{KIND[d.kind] ?? d.kind}</Row>
          {d.direction && d.direction !== 'NONE' && <Row label="Direction">{d.direction === 'SENT' ? 'Sent' : d.direction === 'RECEIVED' ? 'Received' : d.direction}</Row>}
          <Row label="From">{d.sender_name}{d.sender_masked_id && <span className="block font-mono text-xs font-normal text-muted">{d.sender_masked_id}</span>}</Row>
          <Row label="To">{d.recipient_name}{d.recipient_masked_id && <span className="block font-mono text-xs font-normal text-muted">{d.recipient_masked_id}</span>}</Row>
          {d.note && <Row label="Note">{d.note}</Row>}
          {d.order_reference && <Row label="Order">{d.order_reference}</Row>}
          <Row label="Reference"><span className="font-mono text-[0.8rem]">{d.ref}</span></Row>
          {d.utr && <Row label="UTR (reference no.)"><ReferenceNumber value={d.utr} /></Row>}
          <Row label="Date and time">{formatDateTime(d.timestamp)}</Row>
          <Row label="Currency">{d.currency}</Row>
          {d.funding_source && <Row label="Paid from">{d.funding_source}</Row>}
          <Row label="Payment method">{d.payment_method}</Row>
          <Row label="Authentication">{d.authentication}</Row>
          <Row label="Status">{d.status === 'SUCCESS' ? 'Successful' : d.status.charAt(0) + d.status.slice(1).toLowerCase()}</Row>
        </dl>
        {d.failure_message && <p role="alert" className="mx-6 mb-3 rounded-xl bg-danger-soft p-3 text-sm text-danger-ink ring-1 ring-danger-line">{d.failure_message}</p>}
        {d.trail?.length > 0 && (
          <section aria-label="What happened" className="px-6 pb-2">
            <h2 className="mb-2 text-sm font-bold">What happened</h2>
            <Trail steps={d.trail} />
          </section>
        )}
        <p className="px-6 pb-4 text-xs text-muted">{SIMULATION_NOTICE}</p>
        <div className="no-print flex flex-col gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-center">
          <ButtonLink to={ACTIVITY_PATH} variant="secondary">Back to activity</ButtonLink>
          {d.kind === 'REQUEST' && d.status === 'PENDING' && <ButtonLink to={REQUESTS_PATH}>Open requests</ButtonLink>}
          {d.status === 'SUCCESS' && <Button variant="ghost" onClick={() => window.print()}>Print</Button>}
        </div>
      </article>
    </div>
  )
}
