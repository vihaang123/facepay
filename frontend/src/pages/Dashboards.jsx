import { Suspense, lazy } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { StatusBadge, TransactionFeed } from '../components/payUi'
import { Avatar, ButtonLink, Card, EmptyState, ErrorState, FeedSkeleton, PageHeader, Skeleton, StatTile } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMerchantSecuritySummary, getMerchantSummary, getMerchantTransactions, listPaymentSessions } from '../services/payments'
import { formatFeedTime, formatMoney, greeting, isPayable } from '../utils/format'
import { MERCHANT_SESSION_PATH, NEW_PAYMENT_PATH, RECEIPT_PATH, TRANSACTIONS_PATH } from '../utils/roles'

// The chart library is the heaviest dependency; it loads only when a merchant opens their dashboard.
const RevenueChart = lazy(() => import('../components/RevenueChart'))

const linkClass = 'text-sm font-semibold text-brand-700 underline-offset-2 hover:underline'

/** Skeleton while loading, an error with retry on failure, otherwise the content: a section never renders blank. */
function Loaded({ state, label, shape = 'feed', children }) {
  if (state.loading) {
    if (shape === 'tiles') return <div role="status" aria-label={`Loading ${label}`} className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full !rounded-[1.25rem]" />)}</div>
    if (shape === 'line') return <div role="status" aria-label={`Loading ${label}`}><Skeleton className="h-16 w-full" /></div>
    return <FeedSkeleton label={`Loading ${label}`} />
  }
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />
  return children(state.data)
}

// ---------------------------------------------------------------- merchant

function TodayOverview() {
  const { token } = useAuth()
  const state = useLoad(() => getMerchantSummary(token), [token])
  return (
    <section aria-labelledby="today" className="flex flex-col gap-3">
      <h2 id="today" className="text-lg font-bold">Today&apos;s overview</h2>
      <Loaded state={state} label="summary" shape="tiles">
        {(s) => {
          // The series ends with the current day (India time), so its last entry is "today".
          const today = s.revenue_by_day[s.revenue_by_day.length - 1] ?? { revenue: '0', count: 0 }
          return (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile icon="receipt" label="Revenue today" value={formatMoney(today.revenue, s.currency)} hint={`${formatMoney(s.total_revenue, s.currency)} in total`} />
                <StatTile icon="check" label="Successful payments" value={today.count} hint={`${s.successful_payments} in total`} />
                <StatTile icon="pending" label="Waiting for customer" value={s.open_sessions} hint="Open payment requests" />
                <StatTile icon="x" label="Failed payments" value={s.failed_payments} hint="All time" />
              </div>
              <Suspense fallback={<Skeleton className="h-56 w-full !rounded-[1.25rem]" />}>
                <RevenueChart days={s.revenue_by_day} />
              </Suspense>
            </>
          )
        }}
      </Loaded>
    </section>
  )
}

function SecuritySummary() {
  const { token } = useAuth()
  const state = useLoad(() => getMerchantSecuritySummary(token), [token])
  return (
    <Card title="Payment security" aria-label="Payment security">
      <Loaded state={state} label="security summary" shape="line">
        {(x) => (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              {[
                ['Payment requests', x.sessions],
                ['Paid', x.paid],
                ['Verified by face', x.face_verified_sessions],
                ['Closed after failed checks', x.closed_after_failed_face_checks],
                ['Paid with PIN step-up', x.paid_with_pin_step_up],
                ['Cancelled or expired', x.cancelled + x.expired],
              ].map(([k, v]) => <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1.5"><dt className="text-slate-600">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
            </dl>
            <p className="mt-3 text-xs text-slate-600">{x.note}</p>
          </>
        )}
      </Loaded>
    </Card>
  )
}

function RecentTransactions() {
  const { token } = useAuth()
  const state = useLoad(() => getMerchantTransactions(token, { limit: 5 }), [token])
  return (
    <Card title="Recent payments" action={<Link className={linkClass} to={TRANSACTIONS_PATH.merchant}>See all</Link>}>
      <Loaded state={state} label="recent transactions">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No payments yet" action={<ButtonLink to={NEW_PAYMENT_PATH}>Create payment</ButtonLink>}>
              Create a payment request and share the link with a customer.
            </EmptyState>
          ) : (
            <TransactionFeed rows={rows} role="merchant" receiptPath={RECEIPT_PATH.merchant} label="Recent transactions" />
          )
        }
      </Loaded>
    </Card>
  )
}

function PaymentSessions() {
  const { token } = useAuth()
  const state = useLoad(() => listPaymentSessions(token, 8), [token])
  const active = state.data?.filter((p) => isPayable(p.status)).length ?? 0
  return (
    <Card title="Payment requests" action={state.data && active > 0 ? <span className="text-sm text-slate-700">{active} waiting for a customer</span> : null}>
      <Loaded state={state} label="payment sessions">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No payment requests yet" icon="link" action={<ButtonLink to={NEW_PAYMENT_PATH}>Create payment</ButtonLink>}>
              A payment request is a checkout link for one customer and one amount.
            </EmptyState>
          ) : (
            <ul aria-label="Payment requests" className="divide-y divide-slate-100">
              {rows.map((p) => (
                <li key={p.session_id}>
                  <Link to={MERCHANT_SESSION_PATH(p.session_id)} className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-slate-50">
                    <Avatar name={p.order_reference ?? 'Order'} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold">{p.order_reference}</p>
                      <p className="truncate text-xs text-slate-600">{formatFeedTime(p.created_at)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="amount font-extrabold">{formatMoney(p.amount, p.currency)}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-400" />
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </Card>
  )
}

export function MerchantDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={profile.business_name}
        subtitle={`${greeting()}, ${String(profile.name).trim().split(/\s+/)[0]}. Payments are simulated.`}
        actions={<ButtonLink to={NEW_PAYMENT_PATH} size="lg" className="!w-auto px-6"><Icon name="plus" className="h-4 w-4" strokeWidth="2.4" />Create payment</ButtonLink>}
      />
      <TodayOverview />
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentTransactions />
        <PaymentSessions />
      </div>
      <SecuritySummary />
    </div>
  )
}
