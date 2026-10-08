import { useEffect, useState } from 'react'
import { TransactionFeed } from '../components/payUi'
import { Button, ButtonLink, Card, EmptyState, ErrorState, FeedSkeleton, PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getMerchantTransactions, getMyTransactions } from '../services/payments'
import { NEW_PAYMENT_PATH, PAY_PATH, RECEIPT_PATH } from '../utils/roles'

const PAGE = 10
const STATUS_OPTIONS = [['', 'All statuses'], ['SUCCESS', 'Successful'], ['FAILED', 'Failed'], ['PENDING', 'Pending']]
const SORT_OPTIONS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['amount_desc', 'Highest amount'], ['amount_asc', 'Lowest amount']]

const selectClass = 'min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm'

/** Transaction history for the signed-in role. The server only ever returns that role's own rows. */
export default function Transactions() {
  const { token, role } = useAuth()
  const isMerchant = role === 'merchant'
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('') // debounced
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [search])

  const fetcher = isMerchant ? getMerchantTransactions : getMyTransactions
  // One extra row tells us whether a next page exists, without a count endpoint.
  const state = useLoad(
    () => fetcher(token, { limit: PAGE + 1, offset: page * PAGE, status, q, sort }),
    [token, isMerchant, page, status, q, sort],
  )
  const rows = state.data ? state.data.slice(0, PAGE) : []
  const hasNext = (state.data?.length ?? 0) > PAGE
  const filtered = Boolean(q || status)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={isMerchant ? 'Transactions' : 'Activity'}
        subtitle={isMerchant ? 'Payments received by your business.' : 'Your FacePay payments. Tap one to see its details.'}
      />
      <Card className="!p-4">
        <form role="search" aria-label="Filter transactions" onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="tx-search" className="text-xs font-semibold text-slate-700">Search</label>
            <input
              id="tx-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={60}
              placeholder={isMerchant ? 'Transaction ID, customer or order' : 'Transaction ID, merchant or order'}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-status" className="text-xs font-semibold text-slate-700">Status</label>
            <select id="tx-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }} className={selectClass}>
              {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-sort" className="text-xs font-semibold text-slate-700">Sort by</label>
            <select id="tx-sort" value={sort} onChange={(e) => { setSort(e.target.value); setPage(0) }} className={selectClass}>
              {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </form>

        <div className="mt-4" aria-live="polite" aria-busy={state.loading}>
          {state.loading && !state.data && <FeedSkeleton label="Loading your transactions..." rows={4} />}
          {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
          {state.data && rows.length === 0 && (
            <EmptyState
              title={filtered ? 'No transactions match' : 'No payments yet'}
              action={filtered ? null : <ButtonLink to={isMerchant ? NEW_PAYMENT_PATH : PAY_PATH}>{isMerchant ? 'Create payment' : 'Pay a request'}</ButtonLink>}
            >
              {filtered
                ? 'Try a different search or clear the filters.'
                : isMerchant ? 'When a customer pays one of your payment requests it will appear here.' : 'Open a payment link from a merchant to pay with your face.'}
            </EmptyState>
          )}
          {rows.length > 0 && <TransactionFeed rows={rows} role={role} receiptPath={RECEIPT_PATH[role]} label="Transactions" />}
        </div>

        {(page > 0 || hasNext) && (
          <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
            <Button variant="secondary" onClick={() => setPage((p) => p - 1)} disabled={page === 0 || state.loading}>Previous</Button>
            <span className="text-sm text-slate-700">Page {page + 1}</span>
            <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={!hasNext || state.loading}>Next</Button>
          </nav>
        )}
      </Card>
    </div>
  )
}
