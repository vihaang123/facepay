import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, ButtonLink, ErrorState, Logo, Spinner } from '../components/ui'
import { ConnectFlow } from './Banks'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getBankCatalog, getMyBanks } from '../services/banks'
import { DASHBOARD_PATH, FACE_PATH } from '../utils/roles'

/** After joining: pick the bank your number is linked to, then set up your face. Both can be skipped and done later. */
export default function Welcome() {
  const { token, profile } = useAuth()
  const catalog = useLoad(() => getBankCatalog(token), [token])
  const banks = useLoad(() => getMyBanks(token), [token])
  const [step, setStep] = useState(null) // null = decide from what the account already has
  const [linked, setLinked] = useState(null)

  const loading = catalog.loading || banks.loading
  const failed = catalog.error || banks.error
  const current = step ?? (banks.data?.length ? 'face' : 'bank')

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-4 py-10 sm:px-6">
      <Link to="/" aria-label="FacePay home" className="text-2xl text-fg"><Logo /></Link>
      {loading ? (
        <div className="flex justify-center py-10"><Spinner label="Loading" /></div>
      ) : failed ? (
        <ErrorState message="We could not load your bank list." onRetry={() => { catalog.reload?.(); banks.reload?.() }} />
      ) : current === 'bank' ? (
        <>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Welcome, {profile?.name?.split(' ')[0]}</h1>
            <p className="mt-1 text-sm text-muted">Which bank is your mobile number linked to?</p>
          </div>
          <ConnectFlow
            catalog={catalog.data}
            heading="Choose your bank"
            cancelLabel="Skip for now"
            onDone={(made) => { setLinked(made); setStep('face') }}
            onCancel={() => setStep('face')}
          />
        </>
      ) : (
        <section aria-label="Set up your face" className="rounded-3xl border border-line/80 bg-surface p-6 shadow-card">
          <h1 className="text-2xl font-bold tracking-tight">{linked ? `${linked.bank_name} linked (demo)` : 'One more thing'}</h1>
          <p className="mt-2 text-sm text-fg">
            Payments on FacePay are confirmed with your face, in place of a UPI PIN. Take a few photos now and you can pay straight away.
          </p>
          {!linked && !banks.data?.length && (
            <Alert tone="info" className="mt-3">You have not chosen a bank yet. You can do that any time from Banks, before your first payment.</Alert>
          )}
          <div className="mt-5 flex flex-col gap-2">
            <ButtonLink to={FACE_PATH} size="lg">Set up my face</ButtonLink>
            <ButtonLink to={DASHBOARD_PATH.customer} variant="ghost">I will do this later</ButtonLink>
          </div>
        </section>
      )}
      <p className="text-center text-xs text-muted">Academic prototype. Payments are simulated.</p>
    </main>
  )
}
