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
import { ACTIVITY_PATH, AUTHENTICATE_PATH, BANKS_PATH, FACE_PATH, MY_QR_PATH, PAY_PATH, REQUESTS_PATH, REQUEST_PATH, SCAN_PATH, SECURITY_PATH, SEND_PATH } from '../utils/roles'

const linkClass = 'text-sm font-semibold text-brand-700 underline-offset-2 hover:underline'

const TILES = [
  ['Pay a person', SEND_PATH, 'user', 'By FacePay ID'],
  ['Pay a merchant', PAY_PATH, 'store', 'Link or request'],
  ['Payment requests', REQUESTS_PATH, 'request', 'Money asked of you'],
  ['FacePay nearby', PAY_PATH, 'nearby', 'Demo discovery'],
]

/** The face-first action: the most prominent thing on the screen, with Request money beside it. */
function FaceHero() {
  return (
    <section aria-label="Pay with your face" className="rounded-3xl bg-brand-700 p-6 text-on-accent">
      <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-2xl bg-on-accent/15"><Icon name="face" className="h-7 w-7" /></span>
      <h2 className="mt-4 text-2xl font-bold leading-tight tracking-tight">Pay with your face.<br />Confirm with confidence.</h2>
      <p className="mt-2 max-w-sm text-sm opacity-90">Open a payment, check who and how much, verify your face, then confirm. Nothing is paid until you say so.</p>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Link
          to={PAY_PATH}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-surface px-6 text-base font-semibold text-brand-800 transition hover:opacity-95 active:scale-[0.98] motion-reduce:transition-none"
        >
          <Icon name="face" className="h-5 w-5" />Pay with Face
        </Link>
        <Link
          to={REQUEST_PATH}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-on-accent/40 px-6 text-base font-semibold transition hover:bg-on-accent/10 active:scale-[0.98] motion-reduce:transition-none"
        >
          <Icon name="request" className="h-5 w-5" />Request money
        </Link>
      </div>
      <p className="mt-4 text-xs opacity-80">Simulated payments. No real bank account is accessed and no money is transferred.</p>
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
        <Link key={label} to={to} className="relative flex min-h-24 flex-col items-start justify-between gap-3 rounded-2xl border border-line bg-surface p-4 transition hover:border-brand-200 active:scale-[0.98] motion-reduce:transition-none">
          <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
          <span>
            <span className="block text-sm font-bold leading-tight">{label}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
          {to === REQUESTS_PATH && waiting > 0 && (
            <span aria-label={`${waiting} waiting for you`} className="absolute right-3 top-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[0.7rem] font-bold text-on-accent">{waiting > 9 ? '9+' : waiting}</span>
          )}
        </Link>
      ))}
    </nav>
  )
}

// Everything that used to crowd the header. The header keeps five daily actions; the rest is one tap from here.
const MORE = [
  ['Bank accounts', BANKS_PATH, 'bank'],
  ['Scan QR', SCAN_PATH, 'scan'],
  ['My QR', MY_QR_PATH, 'qr'],
  ['Face profile', FACE_PATH, 'face'],
  ['Security and PIN', SECURITY_PATH, 'shield'],
]

function MoreLinks() {
  return (
    <Card title="More" aria-label="More" className="lg:hidden">
      <ul aria-label="More options" className="grid grid-cols-2 gap-2">
        {MORE.map(([label, to, icon]) => (
          <li key={to}>
            <Link to={to} className="flex min-h-12 items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-semibold transition hover:border-brand-200 hover:bg-brand-50/40 active:scale-[0.98] motion-reduce:transition-none">
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1 leading-tight">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
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
          <p className="text-sm text-fg">Connect a demo bank account to choose where your payments come from. You need one to confirm a payment.</p>
          <ButtonLink to={BANKS_PATH} variant="secondary"><Icon name="bank" className="h-4 w-4" />Connect a demo bank</ButtonLink>
        </div>
      ) : (
        <ul aria-label="Connected banks" className="flex flex-col gap-2">
          {state.data.slice(0, 3).map((c) => (
            <li key={c.connection_id} className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sunken text-fg"><Icon name="bank" className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words font-semibold leading-tight">{c.bank_name} · {c.account_type_label}</p>
                <p className="font-mono text-xs text-muted">{c.account_ref}</p>
              </div>
              {c.is_default && <span className="shrink-0 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">Default</span>}
            </li>
          ))}
          {state.data.length > 3 && <li className="text-xs text-muted">and {state.data.length - 3} more</li>}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{DEMO_DISCLAIMER}</p>
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
                <span aria-hidden="true" className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${ready ? 'bg-success-soft text-success-ink' : 'bg-warning-soft text-warning-ink'}`}>
                  <Icon name={ready ? 'shield' : 'face'} className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold leading-tight">{ready ? 'Face authentication ready' : status.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{ready ? 'You can approve payments with your face.' : status.text}</p>
                </div>
                <Link className={`${linkClass} shrink-0`} to={FACE_PATH}>{status.cta}</Link>
              </div>
              {ready && (
                <p className="text-xs text-muted">Want shops and friends to find you with a camera? <Link className={linkClass} to={SECURITY_PATH}>Turn on “find me by face”</Link>. It is off until you do.</p>
              )}
              {!ready && (
                <div>
                  <div className="flex justify-between text-xs font-semibold text-fg">
                    <span>Face setup</span>
                    <span>{Math.min(enrollment.total_samples, enrollment.min_samples_to_train)} of {enrollment.min_samples_to_train} photos</span>
                  </div>
                  <div role="progressbar" aria-label="Face setup progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="mt-1 h-2 overflow-hidden rounded-full bg-track">
                    <div className="h-full rounded-full bg-brand-700 transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
              <p className="text-xs text-muted">
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

export default function CustomerHome() {
  const { profile } = useAuth()
  const [notice, setNotice] = useState(null)
  const first = String(profile.name).trim().split(/\s+/)[0]
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{greeting()}, {first}</h1>
          {profile.facepay_id && (
            <div className="mt-1.5">
              <p className="text-xs font-semibold text-muted">Your FacePay ID</p>
              <IdChip id={profile.facepay_id} name={profile.name} onNotice={setNotice} />
            </div>
          )}
        </div>
      </header>
      {notice && <Alert tone="info">{notice}</Alert>}

      <FaceHero />
      <Tiles />

      <RecentActivity />
      <ConnectedBanks />
      <SecurityStatus />
      <MoreLinks />
      <p className="text-center text-sm">
        <Link className={linkClass} to={AUTHENTICATE_PATH}>Try a test face check</Link>
        <span className="text-muted"> without making a payment</span>
      </p>
    </div>
  )
}
