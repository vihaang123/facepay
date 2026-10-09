import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { StatusBadge } from '../components/payUi'
import { Alert, Avatar, Button, ButtonLink, Card, EmptyState, ErrorState, FeedSkeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { cancelRequest, declineRequest, listRequests, payRequest } from '../services/transfers'
import { formatDateTime, formatMoney } from '../utils/format'
import { newKey } from '../utils/money'
import { CHECKOUT_PATH, REQUEST_PATH } from '../utils/roles'

const TABS = [['incoming', 'Asked of you'], ['outgoing', 'You asked']]

function RequestCard({ r, onChanged }) {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const incoming = r.direction === 'INCOMING'
  const pending = r.status === 'PENDING'

  const run = async (name, fn) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err.message)
      setBusy(null)
    }
  }
  const pay = () => run('pay', async () => {
    const session = await payRequest(token, r.request_id, newKey())
    navigate(CHECKOUT_PATH(session.session_id))
  })

  return (
    <li className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-card">
      <div className="flex items-start gap-3">
        <Avatar name={r.counterparty_name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{incoming ? `${r.counterparty_name} asked you` : `You asked ${r.counterparty_name}`}</p>
          <p className="font-mono text-xs text-slate-600">{r.counterparty_masked_id}</p>
          {r.note && <p className="mt-1 text-sm text-slate-700">{r.note}</p>}
          <p className="mt-1 text-xs text-slate-600">{pending ? `Expires ${formatDateTime(r.expires_at)}` : `Closed ${formatDateTime(r.resolved_at)}`}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="amount font-extrabold">{formatMoney(r.amount, r.currency)}</span>
          <StatusBadge status={r.status} />
        </div>
      </div>
      {error && <Alert tone="error" className="mt-3">{error}</Alert>}
      {pending && (
        <div className="mt-3 flex gap-2">
          {incoming ? (
            <>
              <Button className="flex-1" onClick={pay} loading={busy === 'pay'} disabled={Boolean(busy) && busy !== 'pay'}>Pay</Button>
              <Button className="flex-1" variant="secondary" onClick={() => run('decline', () => declineRequest(token, r.request_id))} loading={busy === 'decline'} disabled={Boolean(busy) && busy !== 'decline'}>Decline</Button>
            </>
          ) : (
            <Button className="flex-1" variant="secondary" onClick={() => run('cancel', () => cancelRequest(token, r.request_id))} loading={busy === 'cancel'}>Cancel request</Button>
          )}
        </div>
      )}
      {r.transaction_id && <p className="mt-2 text-xs text-slate-600">Paid as <span className="font-mono">{r.transaction_id}</span></p>}
    </li>
  )
}

export default function Requests() {
  const { token } = useAuth()
  const [box, setBox] = useState('incoming')
  const state = useLoad(() => listRequests(token, { box, limit: 50 }), [token, box])
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Requests</h1>
          <p className="mt-1 text-sm text-slate-600">Paying a request never happens automatically. You verify your face and confirm each one.</p>
        </div>
        <ButtonLink to={REQUEST_PATH} variant="secondary">Request money</ButtonLink>
      </div>
      <div role="tablist" aria-label="Requests" className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={box === id} onClick={() => setBox(id)} className={`min-h-10 rounded-lg text-sm font-semibold transition ${box === id ? 'bg-white shadow-sm' : 'text-slate-700'}`}>{label}</button>
        ))}
      </div>
      <Card flush className="!p-0 !border-0 !bg-transparent !shadow-none">
        {state.loading ? <FeedSkeleton label="Loading requests" /> : state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : state.data.length === 0 ? (
          <EmptyState title={box === 'incoming' ? 'Nobody has asked you for money' : 'You have not asked anyone yet'} icon="request">
            {box === 'incoming' ? 'Requests sent to you appear here.' : 'Requests you send appear here.'}
          </EmptyState>
        ) : (
          <ul aria-label="Requests" className="flex flex-col gap-3">{state.data.map((r) => <RequestCard key={r.request_id} r={r} onChanged={state.reload} />)}</ul>
        )}
      </Card>
    </div>
  )
}
