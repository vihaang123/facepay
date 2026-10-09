import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityList, NoActivity } from '../components/money'
import Icon from '../components/Icon'
import { Button, ErrorState, FeedSkeleton } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { getActivity } from '../services/transfers'

const FILTERS = [['all', 'All'], ['sent', 'Sent'], ['received', 'Received'], ['successful', 'Successful'], ['failed', 'Failed'], ['pending', 'Pending']]
const PAGE = 20

export default function Activity() {
  const { token } = useAuth()
  const [filter, setFilter] = useState('all')
  const [text, setText] = useState('')
  const [q, setQ] = useState('') // what has actually been searched for (typing is debounced)
  const [rows, setRows] = useState(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  const load = useCallback(async () => {
    const mine = ++seq.current
    setRows(null)
    setError(null)
    try {
      const page = await getActivity(token, { filter, q, limit: PAGE + 1 })
      if (mine !== seq.current) return
      setRows(page.slice(0, PAGE))
      setMore(page.length > PAGE)
    } catch (err) {
      if (mine === seq.current) setError(err.message)
    }
  }, [token, filter, q])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const page = await getActivity(token, { filter, q, limit: PAGE + 1, offset: rows.length })
      setRows((r) => [...r, ...page.slice(0, PAGE)])
      setMore(page.length > PAGE)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-slate-600">Payments you made and received, and your money requests.</p>
      </div>
      <div className="relative">
        <label htmlFor="activity-search" className="sr-only">Search activity</label>
        <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
        <input
          id="activity-search"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name, note or reference"
          autoComplete="off"
          className="min-h-12 w-full rounded-xl border border-slate-300 bg-white pl-11 pr-3 text-base focus:border-brand-700"
        />
      </div>
      <div role="group" aria-label="Filter activity" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold ring-1 ring-inset transition ${filter === id ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-800 ring-slate-300 hover:bg-slate-50'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <section aria-label="Activity list" className="rounded-[1.25rem] border border-slate-200/80 bg-white p-4 shadow-card">
        {error && !rows ? <ErrorState message={error} onRetry={load} /> : rows === null ? <FeedSkeleton label="Loading activity" rows={4} /> : rows.length === 0 ? <NoActivity filtered={filter !== 'all' || q !== ''} /> : (
          <>
            <ActivityList rows={rows} />
            {more && <Button variant="secondary" className="mt-3 w-full" onClick={loadMore} loading={loadingMore}>Load more</Button>}
            {error && <p role="alert" className="mt-3 text-sm text-rose-800">{error}</p>}
          </>
        )}
      </section>
    </div>
  )
}
