import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RevenueChart from '../components/RevenueChart'
import { StatusBadge } from '../components/payUi'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { getMerchantSummary, getMerchantTransactions, getMyTransactions, listPaymentSessions } from '../services/payments'
import { formatDateTime, formatMoney } from '../utils/format'
import { AUTHENTICATE_PATH, FACE_PATH, MERCHANT_SESSION_PATH, NEW_PAYMENT_PATH, PROFILE_PATH, RECEIPT_PATH } from '../utils/roles'

function Card({ title, children, status }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {status && (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">{status}</span>
        )}
      </div>
      <div className="mt-2 text-sm text-slate-600">{children}</div>
    </section>
  )
}

/** Loads once; exposes { data, error, loading } so each dashboard section can show its own state. */
function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null })
  useEffect(() => {
    let live = true
    fn()
      .then((data) => live && setState({ data, error: null }))
      .catch((err) => live && setState({ data: null, error: err.status === 0 ? err.message : err.status >= 500 ? 'Something went wrong on our side.' : err.message }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { ...state, loading: !state.data && !state.error }
}

function Table({ label, head, children }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="mt-3 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            {head.map((h) => <th key={h} className="py-1 pr-3 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Section({ title, state, empty, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold">{title}</h2>
      {state.loading && <div className="mt-3"><Spinner label={`Loading ${title.toLowerCase()}`} /></div>}
      {state.error && <div className="mt-3"><Alert tone="error">{state.error}</Alert></div>}
      {state.data && state.data.length === 0 && <p className="mt-3 text-sm text-slate-500">{empty}</p>}
      {state.data && state.data.length > 0 && children(state.data)}
    </section>
  )
}

function PaymentHistory() {
  const { token } = useAuth()
  const state = useLoad(() => getMyTransactions(token, 20), [token])
  return (
    <Section title="Payment history" state={state} empty="No payments yet. Open a checkout link from a merchant to pay with your face.">
      {(rows) => (
        <Table label="Payment history" head={['Date', 'Merchant', 'Order', 'Amount', 'Status', 'Transaction ID']}>
          {rows.map((t) => (
            <tr key={t.transaction_id} className="border-b border-slate-100">
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(t.timestamp)}</td>
              <td className="py-1.5 pr-3">{t.merchant_name}</td>
              <td className="py-1.5 pr-3">{t.order_reference ?? '—'}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatMoney(t.amount, t.currency)}</td>
              <td className="py-1.5 pr-3"><StatusBadge status={t.status} /></td>
              <td className="py-1.5 font-mono text-xs">
                <Link className="text-brand-600" to={RECEIPT_PATH.customer(t.transaction_id)}>{t.transaction_id}</Link>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  )
}

export function CustomerDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome, {profile.name}</h1>
        <p className="mt-1 text-sm text-slate-600">Pay merchants with your face. All payments are simulated.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Face registration">
          Capture face samples, train the PCA-LDA model and test recognition.{' '}
          <Link className="font-semibold text-brand-600" to={FACE_PATH}>
            Open face setup
          </Link>
        </Card>
        <Card title="FacePay authentication">
          Liveness check, then PCA-LDA identity verification.{' '}
          <Link className="font-semibold text-brand-600" to={AUTHENTICATE_PATH}>
            Authenticate with your face
          </Link>
        </Card>
        <Card title="Account">
          Signed in as {profile.email}. <Link className="font-semibold text-brand-600" to={PROFILE_PATH.customer}>Edit profile</Link>
        </Card>
      </div>
      <PaymentHistory />
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
    </div>
  )
}

function MerchantOverview() {
  const { token } = useAuth()
  const summary = useLoad(() => getMerchantSummary(token), [token])
  const s = summary.data
  return (
    <>
      {summary.loading && <Spinner label="Loading summary" />}
      {summary.error && <Alert tone="error">{summary.error}</Alert>}
      {s && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total simulated revenue" value={formatMoney(s.total_revenue, s.currency)} />
            <Stat label="Transactions" value={s.transactions} />
            <Stat label="Successful payments" value={s.successful_payments} />
            <Stat label="Failed payments" value={s.failed_payments} />
          </div>
          <RevenueChart days={s.revenue_by_day} />
        </>
      )}
    </>
  )
}

function MerchantTables() {
  const { token } = useAuth()
  const tx = useLoad(() => getMerchantTransactions(token, 10), [token])
  const sessions = useLoad(() => listPaymentSessions(token, 10), [token])
  return (
    <>
      <Section title="Recent transactions" state={tx} empty="No transactions yet.">
        {(rows) => (
          <Table label="Recent transactions" head={['Date', 'Customer', 'Order', 'Amount', 'Status', 'Transaction ID']}>
            {rows.map((t) => (
              <tr key={t.transaction_id} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(t.timestamp)}</td>
                <td className="py-1.5 pr-3">{t.payer_name}</td>
                <td className="py-1.5 pr-3">{t.order_reference ?? '—'}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatMoney(t.amount, t.currency)}</td>
                <td className="py-1.5 pr-3"><StatusBadge status={t.status} /></td>
                <td className="py-1.5 font-mono text-xs">
                  <Link className="text-brand-600" to={RECEIPT_PATH.merchant(t.transaction_id)}>{t.transaction_id}</Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Payment sessions" state={sessions} empty="No payment sessions yet. Create one to get a checkout link.">
        {(rows) => (
          <Table label="Payment sessions" head={['Created', 'Order', 'Amount', 'Status', '']}>
            {rows.map((p) => (
              <tr key={p.session_id} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateTime(p.created_at)}</td>
                <td className="py-1.5 pr-3">{p.order_reference}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatMoney(p.amount, p.currency)}</td>
                <td className="py-1.5 pr-3"><StatusBadge status={p.status} /></td>
                <td className="py-1.5"><Link className="text-brand-600" to={MERCHANT_SESSION_PATH(p.session_id)}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </>
  )
}

export function MerchantDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{profile.business_name}</h1>
          <p className="mt-1 text-sm text-slate-600">Welcome, {profile.name}. Payments are simulated.</p>
        </div>
        <Link to={NEW_PAYMENT_PATH} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500">
          Create payment
        </Link>
      </div>
      <MerchantOverview />
      <MerchantTables />
    </div>
  )
}
