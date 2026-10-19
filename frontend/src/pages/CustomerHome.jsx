import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { ActivityList, IdChip, NoActivity } from '../components/money'
import { Alert, ButtonLink, Card, ErrorState, FeedSkeleton, Skeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getAttempts } from '../services/faceAuth'
import { getEnrollment, getModel } from '../services/faces'
import { getMyBanks } from '../services/banks'
import { getActivity, getActivityCounts } from '../services/transfers'
import { faceStatus } from '../utils/faceStatus'
import { DEMO_DISCLAIMER } from '../utils/demo'
import { formatFeedTime, greeting } from '../utils/format'
import { ACTIVITY_PATH, AUTHENTICATE_PATH, BANKS_PATH, FACE_PATH, MY_QR_PATH, PAY_PATH, PROFILE_PATH, REQUESTS_PATH, REQUEST_PATH, SCAN_PATH, SECURITY_PATH, SEND_PATH } from '../utils/roles'

const linkClass = 'text-sm font-semibold text-brand-700 underline-offset-2 hover:underline'

const TILES = [
  ['Pay a person', SEND_PATH, 'user', 'By FacePay ID'],
  ['Pay a merchant', PAY_PATH, 'store', 'Link or request'],
  ['Payment requests', REQUESTS_PATH, 'request', 'Money asked of you'],
  ['FacePay nearby', PAY_PATH, 'nearby', 'Demo discovery'],
]

/** The face-first action: the most prominent thing on the screen. */
function FaceHero() {
  return (
    <section aria-label="Pay with your face" className="relative overflow-hidden rounded-[1.75rem] bg-brand-800 p-6 text-white shadow-card">
      <span aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 h-36 w-36 rounded-full bg-white/10" />
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-10 right-10 h-24 w-24 rounded-full bg-white/5" />
      <div className="relative">
        <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15"><Icon name="face" className="h-8 w-8" /></span>
        <h2 className="mt-4 text-2xl font-extrabold leading-tight tracking-tight">Pay with your face.<br />Confirm with confidence.</h2>
        <p className="mt-2 max-w-sm text-sm text-white/85">Open a payment, check who and how much, verify your face, then confirm. Nothing is paid until you say so.</p>
        <Link
          to={PAY_PATH}
          className="mt-5 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-base font-bold text-brand-800 shadow-sm transition hover:bg-brand-50 active:scale-[0.98] motion-reduce:transition-none"
        >
          <Icon name="face" className="h-5 w-5" />Pay with Face
        </Link>
        <p className="mt-3 text-xs text-white/80">Simulated payments. No real bank account is accessed and no money is transferred.</p>
      </div>
    </section>
  )
}

function Tiles() {
  const { token } = useAuth()
  const counts = useLoad(() => getActivityCounts(token), [token])
  const waiting = counts.data?.pending_incoming_requests ?? 0
  return (
    <nav aria-label="Payment options" className="grid grid-cols-2 gap-3">
      {TILES.map(([label, to, icon, hint]) => (
        <Link key={label} to={to} className="relative flex min-h-[6.5rem] flex-col items-start justify-between gap-3 rounded-[1.25rem] border border-slate-200/80 bg-white p-4 shadow-card transition hover:border-brand-200 active:scale-[0.98] motion-reduce:transition-none">
          <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
          <span>
            <span className="block text-sm font-bold leading-tight">{label}</span>
            <span className="block text-xs text-slate-600">{hint}</span>
          </span>
          {to === REQUESTS_PATH && waiting > 0 && (
            <span aria-label={`${waiting} waiting for you`} className="absolute right-3 top-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[0.7rem] font-bold text-white">{waiting > 9 ? '9+' : waiting}</span>
          )}
        </Link>
      ))}
    </nav>
  )
}

function ConnectedBanks() {
  const { token } = useAuth()
  const state = useLoad(() => getMyBanks(token), [token])
  return (
    <Card title="Connected bank accounts" aria-label="Connected bank accounts" action={<Link className={linkClass} to={BANKS_PATH}>Manage</Link>}>
      {state.loading ? (
        <div role="status" aria-label="Loading bank accounts"><Skeleton className="h-14 w-full" /></div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : state.data.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-700">Connect a demo bank account to choose where your payments come from. You need one to confirm a payment.</p>
          <ButtonLink to={BANKS_PATH} variant="secondary"><Icon name="bank" className="h-4 w-4" />Connect a demo bank</ButtonLink>
        </div>
      ) : (
        <ul aria-label="Connected banks" className="flex flex-col gap-2">
          {state.data.slice(0, 3).map((c) => (
            <li key={c.connection_id} className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700"><Icon name="bank" className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold leading-tight">{c.bank_name} · {c.account_type_label}</p>
                <p className="font-mono text-xs text-slate-600">{c.account_ref}</p>
              </div>
              {c.is_default && <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">Default</span>}
            </li>
          ))}
          {state.data.length > 3 && <li className="text-xs text-slate-600">and {state.data.length - 3} more</li>}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-600">{DEMO_DISCLAIMER}</p>
    </Card>
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
    <Card title="Recent payments" action={<Link className={linkClass} to={ACTIVITY_PATH}>View all</Link>}>
      {state.loading ? <FeedSkeleton label="Loading recent payments" /> : state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : state.data.length === 0 ? <NoActivity /> : <ActivityList rows={state.data} label="Recent payments" />}
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

      <FaceHero />
      <Tiles />

      <RecentActivity />
      <ConnectedBanks />
      <SecurityStatus />
      <nav aria-label="More" className="flex flex-wrap justify-center gap-x-5 gap-y-1">
        <Link className={linkClass} to={REQUEST_PATH}>Request money</Link>
        <Link className={linkClass} to={SCAN_PATH}>Scan QR</Link>
        <Link className={linkClass} to={MY_QR_PATH}>My QR</Link>
        <Link className={linkClass} to={PROFILE_PATH.customer}>Profile</Link>
      </nav>
      <p className="text-center text-sm">
        <Link className={linkClass} to={AUTHENTICATE_PATH}>Try a test face check</Link>
        <span className="text-slate-600"> without making a payment</span>
      </p>
    </div>
  )
}
