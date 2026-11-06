import { useState } from 'react'
import { BankMark, DemoNotice } from '../components/banks'
import Icon from '../components/Icon'
import { Alert, Button, Card, ConfirmPanel, EmptyState, ErrorState, FeedSkeleton, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { useToast } from '../hooks/useToast'
import { connectBank, disconnectBank, getBankCatalog, getMyBanks, makeDefaultBank } from '../services/banks'

/** Three small steps, none of which asks for anything secret: pick a bank, see that it is a simulation, pick a demo account. */
function ConnectFlow({ catalog, onDone, onCancel }) {
  const { token } = useAuth()
  const [bank, setBank] = useState(null)
  const [accountType, setAccountType] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await connectBank(token, { bankCode: bank.code, accountType })
      onDone(made)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (!bank) {
    return (
      <Card title="Choose a bank" aria-label="Choose a bank">
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
        <Button variant="ghost" onClick={onCancel} className="mt-3">Cancel</Button>
      </Card>
    )
  }

  return (
    <Card title={`Connect ${bank.name}`} aria-label="Connect a demo account">
      <div className="flex items-center gap-3">
        <BankMark bank={bank} size="h-12 w-12 text-xs" />
        <div className="min-w-0">
          <p className="font-bold leading-tight">{bank.name}</p>
          <p className="text-xs font-semibold text-warning-ink">Simulated connection</p>
        </div>
      </div>
      <DemoNotice className="mt-3" />
      <p className="mt-3 text-sm text-fg">
        FacePay does not open {bank.name}, ask you to sign in or ask for any bank detail. Pick a demo account profile and FacePay will create a demo record you can pay from.
      </p>
      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Demo account profile</legend>
        <div className="mt-2 flex flex-col gap-2">
          {catalog.account_types.map((t) => (
            <label key={t.code} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 transition ${accountType === t.code ? 'border-brand-600 bg-brand-50' : 'border-line bg-surface hover:border-line-strong'}`}>
              <input type="radio" name="account-type" value={t.code} checked={accountType === t.code} onChange={() => setAccountType(t.code)} className="h-4 w-4 accent-brand-700" />
              <span className="font-semibold">{t.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      <div className="mt-4 flex flex-col gap-2">
        <Button size="lg" onClick={connect} loading={busy} disabled={!accountType}>Create demo connection</Button>
        <Button variant="ghost" onClick={() => { setBank(null); setAccountType(null); setError(null) }} disabled={busy}>Choose another bank</Button>
      </div>
    </Card>
  )
}

function ConnectionCard({ c, bank, onDefault, onAskDisconnect, busy }) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line/80 bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <BankMark bank={bank ?? { short: c.bank_code.toUpperCase().slice(0, 4) }} size="h-12 w-12 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold leading-tight">{c.bank_name}</p>
          <p className="text-sm text-fg">{c.account_type_label}</p>
          <p className="font-mono text-xs text-muted">{c.account_ref}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-semibold text-success-ink ring-1 ring-inset ring-success-line">
            <Icon name="check" className="h-3 w-3" strokeWidth="2.4" />Demo connected
          </span>
          {c.is_default && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">Default</span>}
        </div>
      </div>
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
          onDone={(made) => { setAdding(false); notify(`${made.bank_name} connected (demo)`); banks.reload() }}
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
                <ConnectionCard key={c.connection_id} c={c} bank={byCode[c.bank_code]} onDefault={makeDefault} onAskDisconnect={setLeaving} busy={busy} />
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
      <p className="text-center text-xs text-muted">A linked bank is never proof of funds: FacePay shows no balance and moves no money.</p>
    </div>
  )
}
