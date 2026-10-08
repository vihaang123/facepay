import { Suspense, lazy } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { StatusBadge, TransactionFeed } from '../components/payUi'
import { Avatar, ButtonLink, Card, EmptyState, ErrorState, FeedSkeleton, PageHeader, Skeleton, StatTile } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getEnrollment, getModel } from '../services/faces'
import { getMerchantSummary, getMerchantTransactions, getMyTransactions, getMySummary, listPaymentSessions } from '../services/payments'
import { faceStatus } from '../utils/faceStatus'
import { formatFeedTime, formatMoney, greeting, isPayable } from '../utils/format'
import { AUTHENTICATE_PATH, FACE_PATH, MERCHANT_SESSION_PATH, NEW_PAYMENT_PATH, PAY_PATH, RECEIPT_PATH, TRANSACTIONS_PATH } from '../utils/roles'

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

// ---------------------------------------------------------------- customer

function FaceStatusCard() {
  const { token } = useAuth()
  const state = useLoad(async () => {
    const [enrollment, m] = await Promise.all([getEnrollment(token), getModel(token)])
    return faceStatus(enrollment, m.model)
  }, [token])
  return (
    <Card aria-label="FacePay status" className="!p-4">
      <Loaded state={state} label="face status" shape="line">
        {(s) => {
          const ready = s.badge === 'SUCCESS'
          return (
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                <Icon name={ready ? 'shield' : 'face'} className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-600">FacePay status</p>
                <p className="font-bold leading-tight">{ready ? 'Face authentication ready' : s.label}</p>
                <p className="mt-0.5 text-xs text-slate-600">{ready ? 'Your face profile is set up.' : s.text}</p>
              </div>
              <Link className={`${linkClass} shrink-0`} to={FACE_PATH}>{s.cta}</Link>
            </div>
          )
        }}
      </Loaded>
    </Card>
  )
}

const ACTIONS = [
  ['Pay a request', 'Open a payment link', PAY_PATH, 'link'],
  ['Transactions', 'Your payment history', TRANSACTIONS_PATH.customer, 'receipt'],
  ['Face profile', 'Set up or retrain', FACE_PATH, 'face'],
]

function QuickActions() {
  return (
    <nav aria-label="Quick actions" className="grid grid-cols-3 gap-3">
      {ACTIONS.map(([label, hint, to, icon]) => (
        <Link key={to} to={to} className="flex min-h-[7.5rem] flex-col items-start justify-between rounded-[1.25rem] border border-slate-200/80 bg-white p-3.5 shadow-card transition hover:border-brand-200 active:scale-[0.98]">
          <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
          <span>
            <span className="block text-sm font-bold leading-tight">{label}</span>
            <span className="mt-0.5 hidden text-xs text-slate-600 sm:block">{hint}</span>
          </span>
        </Link>
      ))}
    </nav>
  )
}

function RecentPayments() {
  const { token } = useAuth()
  const state = useLoad(() => getMyTransactions(token, { limit: 5 }), [token])
  return (
    <Card title="Recent payments" action={<Link className={linkClass} to={TRANSACTIONS_PATH.customer}>See all</Link>}>
      <Loaded state={state} label="recent payments">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No payments yet" action={<ButtonLink to={PAY_PATH} variant="secondary">Pay a request</ButtonLink>}>
              When a merchant sends you a payment link, you can pay it with your face.
            </EmptyState>
          ) : (
            <TransactionFeed rows={rows} role="customer" receiptPath={RECEIPT_PATH.customer} label="Recent payments" />
          )
        }
      </Loaded>
    </Card>
  )
}

function SpendingSummary() {
  const { token } = useAuth()
  const state = useLoad(() => getMySummary(token), [token])
  return (
    <Loaded state={state} label="spending summary" shape="line">
      {(s) => (
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Spent in the last 30 days" value={formatMoney(s.spent_last_30_days, s.currency)} hint="Successful simulated payments" />
          <StatTile label="Payments made" value={s.payments} hint={s.last_payment_at ? `Last: ${formatFeedTime(s.last_payment_at)}` : 'Nothing paid so far'} />
        </div>
      )}
    </Loaded>
  )
}

export function CustomerDashboard() {
  const { profile } = useAuth()
  const first = String(profile.name).trim().split(/\s+/)[0]
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{greeting()}, {first}</h1>
        <p className="mt-1 text-sm text-slate-600">Pay merchants with your face. All payments are simulated.</p>
      </div>
      <FaceStatusCard />
      <QuickActions />
      <RecentPayments />
      <SpendingSummary />
      <p className="text-center text-sm">
        <Link className={linkClass} to={AUTHENTICATE_PATH}>Try a test face check</Link>
        <span className="text-slate-600"> without making a payment</span>
      </p>
    </div>
  )
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
    </div>
  )
}
