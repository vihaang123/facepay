import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { StatusBadge } from '../components/payUi'
import { Avatar, ButtonLink, Card, EmptyState, ErrorState, FeedSkeleton, PageHeader, TableWrap, Th } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { useLoad } from '../hooks/useLoad'
import { listPaymentSessions } from '../services/payments'
import { formatDateTime, formatFeedTime, formatMoney } from '../utils/format'
import { MERCHANT_SESSION_PATH, NEW_PAYMENT_PATH } from '../utils/roles'

// The tabs map onto the server's real statuses; nothing here is decided in the browser.
const TABS = [
  ['', 'All'],
  ['CREATED', 'Awaiting'],
  ['PAID', 'Paid'],
  ['EXPIRED', 'Expired'],
  ['CANCELLED', 'Cancelled'],
]

/** Every payment request this business has made: filter by status, search by order, open one to share or cancel it. */
export default function MerchantRequests() {
  const { token } = useAuth()
  const desktop = useIsDesktop()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const state = useLoad(() => listPaymentSessions(token, 100, status), [token, status])
  const q = search.trim().toLowerCase()
  const rows = useMemo(
    () => (state.data ?? []).filter((p) => !q || `${p.order_reference ?? ''} ${p.description ?? ''}`.toLowerCase().includes(q)),
    [state.data, q],
  )

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Payment requests"
        subtitle="A request is a checkout link for one customer and one amount. It shows as Paid only once the server has recorded the payment."
        actions={<ButtonLink to={NEW_PAYMENT_PATH}><Icon name="plus" className="h-4 w-4" strokeWidth="2.4" />Create payment</ButtonLink>}
      />
      <Card className="!p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div role="tablist" aria-label="Request status" className="flex flex-wrap gap-1 rounded-xl bg-sunken p-1">
            {TABS.map(([value, label]) => {
              const on = status === value
              return (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setStatus(value)}
                  className={`min-h-9 rounded-lg px-3.5 text-sm font-semibold transition motion-reduce:transition-none ${on ? 'bg-surface text-fg shadow-card ring-1 ring-line' : 'text-muted hover:text-fg'}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div className="flex flex-col gap-1 lg:w-72">
            <label htmlFor="req-search" className="text-xs font-semibold">Search</label>
            <input id="req-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={60} placeholder="Order reference or details" className="min-h-11 rounded-xl border border-field bg-surface px-3 text-sm" />
          </div>
        </div>

        <div className="mt-4" aria-live="polite" aria-busy={state.loading}>
          {state.loading && !state.data && <FeedSkeleton label="Loading payment requests" rows={4} />}
          {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
          {state.data && rows.length === 0 && (
            <EmptyState title={status || q ? 'No requests match' : 'No payment requests yet'} icon="link" action={status || q ? null : <ButtonLink to={NEW_PAYMENT_PATH}>Create payment</ButtonLink>}>
              {status || q ? 'Try another status or a different search.' : 'Create one and share the link or QR code with a customer.'}
            </EmptyState>
          )}
          {rows.length > 0 && desktop && (
            <TableWrap label="Payment requests">
              <thead>
                <tr><Th>Order</Th><Th>Created</Th><Th>Expires</Th><Th className="text-right">Amount</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.session_id} className="border-b border-line last:border-0">
                    <td className="py-3 pr-3">
                      <Link to={MERCHANT_SESSION_PATH(p.session_id)} className="flex items-center gap-3 font-semibold hover:underline">
                        <Avatar name={p.order_reference ?? 'Order'} size="h-9 w-9 text-xs" />
                        <span className="min-w-0">{p.order_reference}{p.description && <span className="block truncate text-xs font-normal text-muted">{p.description}</span>}</span>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-3 pr-3 text-muted">{formatDateTime(p.created_at)}</td>
                    <td className="whitespace-nowrap py-3 pr-3 text-muted">{p.expires_at ? formatDateTime(p.expires_at) : '—'}</td>
                    <td className="whitespace-nowrap py-3 pr-3 text-right font-semibold tabular-nums">{formatMoney(p.amount, p.currency)}</td>
                    <td className="py-3"><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {rows.length > 0 && !desktop && (
            <ul aria-label="Payment requests" className="divide-y divide-line">
              {rows.map((p) => (
                <li key={p.session_id}>
                  <Link to={MERCHANT_SESSION_PATH(p.session_id)} className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-sunken">
                    <Avatar name={p.order_reference ?? 'Order'} size="h-10 w-10 text-xs" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words font-bold">{p.order_reference}</p>
                      <p className="truncate text-xs text-muted">{formatFeedTime(p.created_at)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="amount font-bold">{formatMoney(p.amount, p.currency)}</span>
                      <StatusBadge status={p.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}
