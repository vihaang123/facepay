import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SecurityNote } from '../components/payUi'
import { Alert, Button, Card, ConfirmPanel, ErrorState, FeedSkeleton, FormField, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { deleteSamples } from '../services/faces'
import { getSecurityOverview, removePaymentPin, setBiometricEnabled, setPaymentPin } from '../services/security'
import { formatDateTime, formatMoney } from '../utils/format'
import { FACE_PATH, RECEIPT_PATH } from '../utils/roles'

const EVENT_LABELS = {
  BIOMETRIC_ENABLED: 'Face payments turned on',
  BIOMETRIC_DISABLED: 'Face payments turned off',
  FACE_DATA_REMOVED: 'Face data removed',
  FACE_CONSENT_GIVEN: 'Face setup consent given',
  PAYMENT_CONFIRMED: 'Payment confirmed',
  PIN_SET: 'Payment PIN set',
  PIN_CHANGED: 'Payment PIN changed',
  PIN_REMOVED: 'Payment PIN removed',
  PIN_FAILED: 'Incorrect payment PIN',
  PIN_LOCKED: 'Payment PIN locked after repeated mistakes',
  DAILY_LIMIT_HIT: 'Daily limit reached',
}

const minutes = (s) => Math.max(1, Math.ceil(s / 60))

function Switch({ checked, onChange, disabled, label, describedBy }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={onChange}
      className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition disabled:opacity-60 ${checked ? 'border-brand-700 bg-brand-700' : 'border-slate-400 bg-slate-200'}`}
    >
      <span aria-hidden="true" className={`inline-block h-6 w-6 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${checked ? 'translate-x-7' : 'translate-x-1'}`} />
    </button>
  )
}

function PinCard({ overview, token, onChanged }) {
  const [open, setOpen] = useState(null) // 'set' | 'remove'
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const close = () => { setOpen(null); setPassword(''); setPin(''); setError(null) }
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (open === 'set') await setPaymentPin(token, { password, newPin: pin })
      else await removePaymentPin(token, { password })
      setDone(open === 'set' ? 'Payment PIN saved.' : 'Payment PIN removed.')
      close()
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Payment PIN">
      <p className="text-sm text-slate-700">
        An optional 6-digit PIN. It is only asked for on payments that look higher risk, such as a large amount or several recent failed face checks. It is not needed for every payment.
      </p>
      <p className="mt-2 text-sm font-semibold" data-testid="pin-state">{overview.pin_set ? 'A payment PIN is set.' : 'No payment PIN is set.'}</p>
      {overview.pin_locked_seconds > 0 && <div className="mt-3"><Alert tone="error">Too many incorrect PIN attempts. Try again in about {minutes(overview.pin_locked_seconds)} minutes.</Alert></div>}
      {done && <div className="mt-3"><Alert tone="success">{done}</Alert></div>}
      {open === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { setDone(null); setOpen('set') }}>{overview.pin_set ? 'Change PIN' : 'Set a PIN'}</Button>
          {overview.pin_set && <Button variant="secondary" onClick={() => { setDone(null); setOpen('remove') }}>Remove PIN</Button>}
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="mt-4 flex max-w-sm flex-col gap-3">
          {error && <Alert tone="error">{error}</Alert>}
          <FormField label="Your account password" id="pin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="We ask for it to confirm this change is yours." />
          {open === 'set' && (
            <FormField
              label="New 6-digit PIN" id="new-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          )}
          <div className="flex gap-2">
            <Button type="submit" loading={busy} disabled={!password || (open === 'set' && pin.length !== 6)}>{open === 'set' ? 'Save PIN' : 'Remove PIN'}</Button>
            <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  )
}

export default function Security() {
  const { token } = useAuth()
  const { data: o, error, loading, reload } = useLoad(() => getSecurityOverview(token), [token])
  const [busy, setBusy] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const act = async (kind, fn, success) => {
    setBusy(kind)
    setNotice(null)
    try {
      await fn()
      if (success) setNotice({ tone: 'success', text: success })
      reload()
    } catch (err) {
      setNotice({ tone: 'error', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  if (loading && !o) return <FeedSkeleton label="Loading security" rows={4} />
  if (error && !o) return <ErrorState message={error} onRetry={reload} />

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <PageHeader title="Security" subtitle="Control how FacePay can be used on your account, and see what happened recently. FacePay is an academic prototype and all payments are simulated." />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card title="Face payments">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold" id="biometric-label">Face authentication for payments</p>
            <p className="mt-1 text-sm text-slate-700" id="biometric-help">
              {o.biometric_enabled ? 'On. You can pay by verifying your face and confirming.' : 'Off. FacePay will not use your face to authorize payments until you turn this back on.'}
            </p>
          </div>
          <Switch
            checked={o.biometric_enabled} disabled={busy !== null} label="Face authentication for payments" describedBy="biometric-help"
            onChange={() => act('toggle', () => setBiometricEnabled(token, !o.biometric_enabled), o.biometric_enabled ? 'Face payments are off.' : 'Face payments are on.')}
          />
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-slate-600">Face setup: </dt><dd className="inline font-semibold">{o.face_enrolled ? 'Complete' : 'Not set up'}</dd></div>
          <div><dt className="inline text-slate-600">Last successful face check: </dt><dd className="inline font-semibold">{o.last_successful_authentication ? formatDateTime(o.last_successful_authentication) : 'None yet'}</dd></div>
        </dl>
        {o.biometric_locked_seconds > 0 && (
          <div className="mt-3"><Alert tone="error">Too many unsuccessful attempts. Please try again in about {minutes(o.biometric_locked_seconds)} minutes or use another verification method.</Alert></div>
        )}
      </Card>

      <PinCard overview={o} token={token} onChanged={reload} />

      <Card title="Your face data">
        <p className="text-sm text-slate-700">
          {o.samples_stored > 0 ? `${o.samples_stored} small encrypted grayscale crops are stored. Camera frames are never kept.` : 'No face data is stored for you.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50" to={FACE_PATH}>{o.face_enrolled ? 'Re-enroll my face' : 'Set up my face'}</Link>
          <Button variant="secondary" onClick={() => setConfirmRemove(true)} disabled={!o.samples_stored || busy !== null || confirmRemove}>Remove my face data</Button>
        </div>
        {confirmRemove && (
          <div className="mt-4">
            <ConfirmPanel
              title="Remove all your face data?" confirmLabel="Remove face data" busy={busy === 'remove'}
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => { setConfirmRemove(false); act('remove', () => deleteSamples(token), 'Your face data was removed. Face payments stay unavailable until you set up your face again.') }}
            >
              This deletes every sample and your stored profile, and the trained model that included them is retired. You will not be able to pay with your face until you set it up again.
            </ConfirmPanel>
          </div>
        )}
      </Card>

      <Card title="Limits">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-slate-600">Per payment: </dt><dd className="inline font-semibold">{formatMoney(o.limits.per_transaction, o.limits.currency)}</dd></div>
          <div><dt className="inline text-slate-600">Per day: </dt><dd className="inline font-semibold">{formatMoney(o.limits.daily, o.limits.currency)}</dd></div>
          <div><dt className="inline text-slate-600">Spent in the last 24 hours: </dt><dd className="inline font-semibold">{formatMoney(o.limits.spent_last_24h, o.limits.currency)}</dd></div>
          <div><dt className="inline text-slate-600">PIN asked from: </dt><dd className="inline font-semibold">{formatMoney(o.limits.step_up_amount, o.limits.currency)}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-slate-600">{o.risk_label}. A payment above the PIN amount, or after several failed face checks, may ask for your PIN. A confirmation lasts {o.limits.authorization_seconds} seconds and works once.</p>
      </Card>

      <Card title="Recent face checks">
        {o.recent_attempts.length === 0 ? <p className="text-sm text-slate-700">No face checks yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {o.recent_attempts.map((a, i) => (
              <li key={`${a.timestamp}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span><span className={`font-semibold ${a.result === 'SUCCESS' ? 'text-emerald-800' : 'text-rose-800'}`}>{a.result === 'SUCCESS' ? 'Successful' : 'Unsuccessful'}</span>{a.category ? `: ${a.category}` : ''}</span>
                <span className="text-xs text-slate-600">{formatDateTime(a.timestamp)}{a.transaction_ref ? ` · ${a.transaction_ref}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent payments">
        {o.recent_transactions.length === 0 ? <p className="text-sm text-slate-700">No payments yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {o.recent_transactions.map((t) => (
              <li key={t.transaction_id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <Link className="font-semibold text-brand-800 underline" to={RECEIPT_PATH.customer(t.transaction_id)}>{t.merchant_name}</Link>
                <span>{formatMoney(t.amount, o.limits.currency)}<span className="ml-2 text-xs text-slate-600">{formatDateTime(t.timestamp)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Security activity">
        {o.recent_events.length === 0 ? <p className="text-sm text-slate-700">Nothing to show yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {o.recent_events.map((e, i) => (
              <li key={`${e.timestamp}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span>{EVENT_LABELS[e.kind] ?? 'Account activity'}</span>
                <span className="text-xs text-slate-600">{formatDateTime(e.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SecurityNote />
    </div>
  )
}
