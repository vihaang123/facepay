import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { AUTHENTICATE_PATH, FACE_PATH, PROFILE_PATH } from '../utils/roles'

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

export function CustomerDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome, {profile.name}</h1>
        <p className="mt-1 text-sm text-slate-600">Your customer account is ready.</p>
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
    </div>
  )
}

export function MerchantDashboard() {
  const { profile } = useAuth()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{profile.business_name}</h1>
        <p className="mt-1 text-sm text-slate-600">Welcome, {profile.name}. Your merchant account is ready.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Create a payment" status="Not available yet">
          Creating bills and viewing transactions will be added in a later phase.
        </Card>
        <Card title="Account">
          Signed in as {profile.email}. <Link className="font-semibold text-brand-600" to={PROFILE_PATH.merchant}>Edit profile</Link>
        </Card>
      </div>
    </div>
  )
}
