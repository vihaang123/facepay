import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { ActivityList, IdChip, NoActivity } from '../components/money'
import { Alert, Card, ErrorState, FeedSkeleton, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getAttempts } from '../services/faceAuth'
import { getEnrollment, getModel } from '../services/faces'
import { getActivity, getActivityCounts, getWallet } from '../services/transfers'
import { faceStatus } from '../utils/faceStatus'
import { formatFeedTime, formatMoney, greeting } from '../utils/format'
import { ACTIVITY_PATH, AUTHENTICATE_PATH, FACE_PATH, MY_QR_PATH, REQUESTS_PATH, REQUEST_PATH, SCAN_PATH, SECURITY_PATH, SEND_PATH } from '../utils/roles'

const linkClass = 'text-sm font-semibold text-brand-700 underline-offset-2 hover:underline'

const ACTIONS = [
  ['Send money', SEND_PATH, 'send'],
  ['Request money', REQUEST_PATH, 'request'],
  ['Scan QR', SCAN_PATH, 'scan'],
  ['My QR', MY_QR_PATH, 'qr'],
]

function Balance() {
  const { token } = useAuth()
  const state = useLoad(() => getWallet(token), [token])
  const [hidden, setHidden] = useState(false)
  return (
    <section aria-label="Balance" className="rounded-[1.5rem] bg-brand-800 p-5 text-white shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-white/80">FacePay balance</p>
        <button
          type="button"
          onClick={() => setHidden((h) => !h)}
          aria-pressed={hidden}
          aria-label={hidden ? 'Show balance' : 'Hide balance'}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/10"
        >
          <Icon name={hidden ? 'eyeoff' : 'eye'} className="h-5 w-5" />
        </button>
      </div>
      {state.loading ? (
        <div role="status" aria-label="Loading balance" className="mt-2"><Skeleton className="h-10 w-44 !bg-white/20" /></div>
      ) : state.error ? (
        <p role="alert" className="mt-2 text-sm">Balance unavailable. <button type="button" onClick={state.reload} className="font-semibold underline">Try again</button></p>
      ) : (
        <p className="amount mt-1 text-4xl font-extrabold" data-testid="balance">{hidden ? '₹ ••••••' : formatMoney(state.data.balance, state.data.currency)}</p>
      )}
      <p className="mt-2 text-xs text-white/80">Simulated balance for this prototype. No real money, bank or UPI account is involved.</p>
    </section>
  )
}

function SecurityStatus() {
  const { token } = useAuth()
  const state = useLoad(async () => {
    const [enrollment, m, attempts] = await Promise.all([getEnrollment(token), getModel(token), getAttempts(token, 1)])
    return { enrollment, status: faceStatus(enrollment, m.model), last: attempts[0] ?? null }
  }, [token])
  return (
    <Card title="Security" aria-label="Security status" action={<Link className={linkClass} to={SECURITY_PATH}>Biometric settings</Link>}>
      {state.loading ? (
        <div role="status" aria-label="Loading security status"><Skeleton className="h-16 w-full" /></div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : (
        (() => {
          const { enrollment, status, last } = state.data
          const ready = status.badge === 'SUCCESS'
          const pct = Math.min(100, Math.round((enrollment.total_samples / Math.max(1, enrollment.min_samples_to_train)) * 100))
          return (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                  <Icon name={ready ? 'shield' : 'face'} className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold leading-tight">{ready ? 'Face authentication ready' : status.label}</p>
                  <p className="mt-0.5 text-xs text-slate-600">{ready ? 'You can approve payments with your face.' : status.text}</p>
                </div>
                <Link className={`${linkClass} shrink-0`} to={FACE_PATH}>{status.cta}</Link>
              </div>
              {!ready && (
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700">
                    <span>Face setup</span>
                    <span>{Math.min(enrollment.total_samples, enrollment.min_samples_to_train)} of {enrollment.min_samples_to_train} photos</span>
                  </div>
                  <div role="progressbar" aria-label="Face setup progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-brand-700 transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
              <p className="text-xs text-slate-600">
                {last ? `Last face check: ${last.result === 'SUCCESS' ? 'verified' : 'not verified'}, ${formatFeedTime(last.timestamp)}` : 'No face checks yet.'}
              </p>
            </div>
          )
        })()
      )}
    </Card>
  )
}

function RecentActivity() {
  const { token } = useAuth()
  const state = useLoad(() => getActivity(token, { limit: 5 }), [token])
  return (
    <Card title="Recent activity" action={<Link className={linkClass} to={ACTIVITY_PATH}>View all</Link>}>
      {state.loading ? <FeedSkeleton label="Loading recent activity" /> : state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : state.data.length === 0 ? <NoActivity /> : <ActivityList rows={state.data} label="Recent activity" />}
    </Card>
  )
}

function Bell() {
  const { token } = useAuth()
  const state = useLoad(() => getActivityCounts(token), [token])
  const n = state.data?.pending_incoming_requests ?? 0
  return (
    <Link
      to={REQUESTS_PATH}
      aria-label={n > 0 ? `Requests, ${n} waiting for you` : 'Requests'}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-slate-800 shadow-card ring-1 ring-slate-200 transition hover:bg-slate-50"
    >
      <Icon name="bell" className="h-5 w-5" />
      {n > 0 && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[0.7rem] font-bold text-white">{n > 9 ? '9+' : n}</span>}
    </Link>
  )
}

export default function CustomerHome() {
  const { profile } = useAuth()
  const [notice, setNotice] = useState(null)
  const first = String(profile.name).trim().split(/\s+/)[0]
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight">{greeting()}, {first}</h1>
          {profile.facepay_id && (
            <div className="mt-1.5">
              <p className="text-xs font-semibold text-slate-600">Your FacePay ID</p>
              <IdChip id={profile.facepay_id} name={profile.name} onNotice={setNotice} />
            </div>
          )}
        </div>
        <Bell />
      </header>
      {notice && <Alert tone="info">{notice}</Alert>}

      <Balance />

      <nav aria-label="Money actions" className="grid grid-cols-4 gap-2.5">
        {ACTIONS.map(([label, to, icon]) => (
          <Link key={to} to={to} className="flex min-h-[5.5rem] flex-col items-center justify-center gap-2 rounded-[1.25rem] border border-slate-200/80 bg-white px-1 py-3 text-center shadow-card transition hover:border-brand-200 active:scale-[0.97] motion-reduce:transition-none">
            <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
            <span className="text-xs font-bold leading-tight">{label}</span>
          </Link>
        ))}
      </nav>

      <RecentActivity />
      <SecurityStatus />
      <p className="text-center text-sm">
        <Link className={linkClass} to={AUTHENTICATE_PATH}>Try a test face check</Link>
        <span className="text-slate-600"> without making a payment</span>
      </p>
    </div>
  )
}
