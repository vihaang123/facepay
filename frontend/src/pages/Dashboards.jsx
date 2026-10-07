import { Suspense, lazy } from 'react'
import { Link } from 'react-router-dom'
import TransactionTable from '../components/TransactionTable'
import { StatusBadge } from '../components/payUi'
import { ButtonLink, Card, EmptyState, ErrorState, PageHeader, Spinner, StatTile, TableWrap, Th } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getEnrollment, getModel } from '../services/faces'
import { getMerchantSummary, getMerchantTransactions, getMyTransactions, getMySummary, listPaymentSessions } from '../services/payments'
import { faceStatus } from '../utils/faceStatus'
import { formatDateTime, formatMoney, isPayable } from '../utils/format'
import { AUTHENTICATE_PATH, FACE_PATH, MERCHANT_SESSION_PATH, NEW_PAYMENT_PATH, PROFILE_PATH, TRANSACTIONS_PATH } from '../utils/roles'

// The chart library is the heaviest dependency; it loads only when a merchant opens their dashboard.
const RevenueChart = lazy(() => import('../components/RevenueChart'))

const linkClass = 'font-semibold text-brand-700 underline-offset-2 hover:underline'

/** Shows loading, error (with retry) or the content: a section never renders blank. */
function Loaded({ state, label, children }) {
  if (state.loading) return <Spinner label={`Loading ${label}`} />
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
    <Card title="FacePay status">
      <Loaded state={state} label="face status">
        {(s) => (
          <div className="flex flex-col items-start gap-3">
            <StatusBadge status={s.badge} label={s.label} />
            <p className="text-sm text-slate-700">{s.text}</p>
            <Link className={`text-sm ${linkClass}`} to={FACE_PATH}>{s.cta}</Link>
          </div>
        )}
      </Loaded>
    </Card>
  )
}

function SpendingSummary() {
  const { token } = useAuth()
  const state = useLoad(() => getMySummary(token), [token])
  return (
    <Loaded state={state} label="spending summary">
      {(s) => (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Total spent" value={formatMoney(s.total_spent, s.currency)} hint="Successful payments only" />
          <StatTile label="Last 30 days" value={formatMoney(s.spent_last_30_days, s.currency)} />
          <StatTile label="Payments made" value={s.payments} hint={s.last_payment_at ? `Last: ${formatDateTime(s.last_payment_at)}` : 'No payments yet'} />
        </div>
      )}
    </Loaded>
  )
}

function RecentPayments() {
  const { token } = useAuth()
  const state = useLoad(() => getMyTransactions(token, { limit: 5 }), [token])
  return (
    <Card title="Recent payments" action={<Link className={`text-sm ${linkClass}`} to={TRANSACTIONS_PATH.customer}>View all</Link>}>
      <Loaded state={state} label="recent payments">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No payments yet">Open a checkout link from a merchant to pay with FacePay.</EmptyState>
          ) : (
            <TransactionTable rows={rows} role="customer" label="Recent payments" />
          )
        }
      </Loaded>
    </Card>
  )
}

export function CustomerDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Welcome, ${profile.name}`}
        subtitle="Pay merchants with your face. All payments are simulated."
        actions={<ButtonLink to={AUTHENTICATE_PATH} variant="secondary">Try a test authentication</ButtonLink>}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2"><FaceStatusCard /></div>
        <Card title="Account">
          <p className="break-all text-sm text-slate-700">{profile.email}</p>
          <p className="mt-2 text-sm"><Link className={linkClass} to={PROFILE_PATH.customer}>Edit profile</Link></p>
        </Card>
      </div>
      <SpendingSummary />
      <RecentPayments />
    </div>
  )
}

// ---------------------------------------------------------------- merchant

function MerchantOverview() {
  const { token } = useAuth()
  const state = useLoad(() => getMerchantSummary(token), [token])
  return (
    <Loaded state={state} label="summary">
      {(s) => (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Total simulated revenue" value={formatMoney(s.total_revenue, s.currency)} />
            <StatTile label="Transactions" value={s.transactions} />
            <StatTile label="Successful payments" value={s.successful_payments} />
            <StatTile label="Failed payments" value={s.failed_payments} />
          </div>
          <Suspense fallback={<Spinner label="Loading chart" />}>
            <RevenueChart days={s.revenue_by_day} />
          </Suspense>
        </>
      )}
    </Loaded>
  )
}

function RecentTransactions() {
  const { token } = useAuth()
  const state = useLoad(() => getMerchantTransactions(token, { limit: 5 }), [token])
  return (
    <Card title="Recent transactions" action={<Link className={`text-sm ${linkClass}`} to={TRANSACTIONS_PATH.merchant}>View all</Link>}>
      <Loaded state={state} label="recent transactions">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No transactions yet">Create a payment session and share the link with a customer.</EmptyState>
          ) : (
            <TransactionTable rows={rows} role="merchant" label="Recent transactions" />
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
    <Card title="Payment sessions" action={state.data && active > 0 ? <span className="text-sm text-slate-700">{active} waiting for a customer</span> : null}>
      <Loaded state={state} label="payment sessions">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No payment sessions yet" action={<ButtonLink to={NEW_PAYMENT_PATH}>Create payment</ButtonLink>}>
              A payment session is a checkout link for one customer and one amount.
            </EmptyState>
          ) : (
            <TableWrap label="Payment sessions">
              <thead>
                <tr><Th>Order</Th><Th className="text-right">Amount</Th><Th>Status</Th><Th className="hidden sm:table-cell">Created</Th><Th><span className="sr-only">Open</span></Th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.session_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 pr-3">{p.order_reference}</td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right font-semibold tabular-nums">{formatMoney(p.amount, p.currency)}</td>
                    <td className="py-2.5 pr-3"><StatusBadge status={p.status} /></td>
                    <td className="hidden whitespace-nowrap py-2.5 pr-3 text-xs text-slate-600 sm:table-cell">{formatDateTime(p.created_at)}</td>
                    <td className="py-2.5 text-right">
                      <Link className={`text-sm ${linkClass}`} to={MERCHANT_SESSION_PATH(p.session_id)} aria-label={`Open payment session ${p.order_reference}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
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
        subtitle={`Welcome, ${profile.name}. Payments are simulated.`}
        actions={<ButtonLink to={NEW_PAYMENT_PATH}>Create payment</ButtonLink>}
      />
      <MerchantOverview />
      <PaymentSessions />
      <RecentTransactions />
    </div>
  )
}
