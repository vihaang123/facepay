import { useState } from 'react'
import { AccountDetails, BankMark, DemoNotice } from '../components/banks'
import Icon from '../components/Icon'
import { Alert, Button, Card, ConfirmPanel, EmptyState, ErrorState, FeedSkeleton, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { useToast } from '../hooks/useToast'
import { connectBank, disconnectBank, getBankCatalog, getMyBanks, makeDefaultBank, setBankBehavior } from '../services/banks'

/**
 * Pick a bank, let FacePay find the account, confirm what it found. The person types no account detail and nothing secret:
 * the server's discovery provider returns the holder name, type, masked number, IFSC and branch, and this screen shows them.
 */
export function ConnectFlow({ catalog, onDone, onCancel, heading = 'Choose a bank', cancelLabel = 'Cancel' }) {
  const { token, profile } = useAuth()
  const [bank, setBank] = useState(null)
  const [linked, setLinked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const link = async () => {
    setBusy(true)
    setError(null)
    try {
      setLinked(await connectBank(token, { bankCode: bank.code }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (linked) {
    return (
      <Card title="Account linked" aria-label="Account linked">
        <div className="flex items-center gap-3">
          <BankMark bank={bank} size="h-12 w-12 text-xs" />
          <p className="min-w-0 text-sm text-fg">FacePay found this account at <strong>{linked.bank_name}</strong>. You did not need to enter anything.</p>
        </div>
        <AccountDetails account={linked} className="mt-4" />
        <DemoNotice className="mt-3" />
        <Button size="lg" className="mt-4" onClick={() => onDone(linked)}>Done</Button>
      </Card>
    )
  }

  if (!bank) {
    return (
      <Card title={heading} aria-label={heading}>
        <DemoNotice className="mb-3" />
        <ul aria-label="Banks" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {catalog.banks.map((b) => (
            <li key={b.code}>
              <button
                type="button"
                onClick={() => setBank(b)}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/40 focus-visible:outline-2"
              >
                <BankMark bank={b} />
                <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                <Icon name="chevron" className="h-4 w-4 shrink-0 text-subtle" />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" onClick={onCancel} className="mt-3">{cancelLabel}</Button>
      </Card>
    )
  }

  return (
    <Card title={`Link ${bank.name}`} aria-label="Link your account">
      <div className="flex items-center gap-3">
        <BankMark bank={bank} size="h-12 w-12 text-xs" />
        <div className="min-w-0">
          <p className="font-bold leading-tight">{bank.name}</p>
          <p className="text-xs font-semibold text-warning-ink">Simulated lookup</p>
        </div>
      </div>
      <DemoNotice className="mt-3" />
      <p className="mt-3 text-sm text-fg">
        FacePay will look up the account linked to {profile?.mobile ? `+91 •••••${profile.mobile.slice(-5)}` : 'you'} at {bank.name} and fill in the details for you. This is a simulation: no bank is contacted, and FacePay never asks for a bank password, UPI PIN, card detail, Aadhaar number or bank OTP.
      </p>
      {busy && <p role="status" className="mt-3 text-sm font-semibold text-brand-800">Looking up your account…</p>}
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      <div className="mt-4 flex flex-col gap-2">
        <Button size="lg" onClick={link} loading={busy}>Find and link my account</Button>
        <Button variant="ghost" onClick={() => { setBank(null); setError(null) }} disabled={busy}>Choose another bank</Button>
      </div>
    </Card>
  )
}

function ConnectionCard({ c, bank, behaviors, onDefault, onAskDisconnect, onBehavior, busy }) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line/80 bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <BankMark bank={bank ?? { short: c.bank_code.toUpperCase().slice(0, 4) }} size="h-12 w-12 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold leading-tight">{c.bank_name}</p>
          {c.holder_name && <p className="truncate text-sm font-semibold">{c.holder_name}</p>}
          <p className="text-sm text-fg">{c.account_type_label}</p>
          <p className="font-mono text-xs text-muted">{c.account_ref}</p>
          {(c.ifsc || c.branch) && <p className="break-words text-xs text-muted">{[c.ifsc, c.branch].filter(Boolean).join(' · ')}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold text-success-ink ring-1 ring-inset ring-success-line">
              <Icon name="check" className="h-3 w-3" strokeWidth="2.4" />{c.link_status_label ?? 'Linked'}
            </span>
            {c.is_default && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">Default</span>}
          </div>
        </div>
      </div>
      {behaviors?.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`behavior-${c.connection_id}`} className="text-xs font-semibold text-muted">Demo: how this account answers a payment</label>
          <select
            id={`behavior-${c.connection_id}`}
            value={c.sim_behavior}
            disabled={busy === c.connection_id}
            onChange={(e) => onBehavior(c, e.target.value)}
            className="min-h-11 rounded-xl border border-field bg-surface px-3 text-sm"
          >
            {behaviors.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
          </select>
          {c.sim_behavior !== 'NORMAL' && <p className="text-xs font-semibold text-warning-ink">Payments from this account will fail on purpose (simulation) until you change this.</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!c.is_default && <Button variant="secondary" onClick={() => onDefault(c)} loading={busy === c.connection_id}>Make default</Button>}
        <Button variant="ghost" onClick={() => onAskDisconnect(c)} disabled={busy === c.connection_id}>Disconnect</Button>
      </div>
    </li>
  )
}

export default function Banks() {
  const { token } = useAuth()
  const notify = useToast()
  const catalog = useLoad(() => getBankCatalog(token), [token])
  const banks = useLoad(() => getMyBanks(token), [token])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(null)
  const [leaving, setLeaving] = useState(null)
  const [error, setError] = useState(null)

  const byCode = Object.fromEntries((catalog.data?.banks ?? []).map((b) => [b.code, b]))
  const count = banks.data?.length ?? 0
  const full = catalog.data && count >= catalog.data.max_connected

  const makeDefault = async (c) => {
    setBusy(c.connection_id)
    setError(null)
    try {
      await makeDefaultBank(token, c.connection_id)
      notify(`${c.bank_name} is now your default`)
      banks.reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }
  const changeBehavior = async (c, behavior) => {
    setBusy(c.connection_id)
    setError(null)
    try {
      await setBankBehavior(token, c.connection_id, behavior)
      notify(`${c.bank_name}: ${(catalog.data?.behaviors ?? []).find((b) => b.code === behavior)?.label ?? behavior}`)
      banks.reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }
  const disconnect = async () => {
    const c = leaving
    setLeaving(null)
    setBusy(c.connection_id)
    setError(null)
    try {
      await disconnectBank(token, c.connection_id)
      notify(`${c.bank_name} disconnected`)
      banks.reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <PageHeader title="Connected bank accounts" subtitle="Choose which demo account a payment comes from." />
      <DemoNotice />
      {error && <Alert tone="error">{error}</Alert>}

      {adding && catalog.data ? (
        <ConnectFlow
          catalog={catalog.data}
          onCancel={() => setAdding(false)}
          onDone={(made) => { setAdding(false); notify(`${made.bank_name} linked (demo)`); banks.reload() }}
        />
      ) : (
        <>
          {banks.loading ? (
            <FeedSkeleton label="Loading connected banks" />
          ) : banks.error ? (
            <ErrorState message={banks.error} onRetry={banks.reload} />
          ) : count === 0 ? (
            <EmptyState title="No bank connected yet" icon="bank">
              Connect a demo bank account so you can confirm payments. You need at least one to pay.
            </EmptyState>
          ) : (
            <ul aria-label="Connected bank accounts" className="flex flex-col gap-3">
              {banks.data.map((c) => (
                <ConnectionCard key={c.connection_id} c={c} bank={byCode[c.bank_code]} behaviors={catalog.data?.behaviors} onDefault={makeDefault} onAskDisconnect={setLeaving} onBehavior={changeBehavior} busy={busy} />
              ))}
            </ul>
          )}
          {leaving && (
            <ConfirmPanel title={`Disconnect ${leaving.bank_name}?`} confirmLabel="Disconnect" cancelLabel="Keep it" onConfirm={disconnect} onCancel={() => setLeaving(null)}>
              You will not be able to choose this demo account for new payments. Past payments keep showing it as their funding source.
            </ConfirmPanel>
          )}
          <Button size="lg" onClick={() => setAdding(true)} disabled={!catalog.data || full}>
            <Icon name="plus" className="h-4 w-4" strokeWidth="2.4" />Connect a demo bank
          </Button>
          {full && <p className="text-center text-xs text-muted">You can connect up to {catalog.data.max_connected} demo accounts. Disconnect one to add another.</p>}
          {catalog.error && <Alert tone="error">The bank list could not load. {catalog.error}</Alert>}
        </>
      )}
      {catalog.data?.behavior_note && <p className="text-center text-xs text-muted">{catalog.data.behavior_note}</p>}
      <p className="text-center text-xs text-muted">A linked bank is never proof of funds: FacePay shows no balance and moves no money.</p>
    </div>
  )
}
