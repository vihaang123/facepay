import { Link } from 'react-router-dom'
import Icon from './Icon'
import { StatusBadge } from './payUi'
import { Avatar, ButtonLink, EmptyState } from './ui'
import { useCopy } from '../hooks/useCopy'
import { formatFeedTime, formatMoney } from '../utils/format'
import { activityTitle } from '../utils/activity'
import { ACTIVITY_DETAIL_PATH, SEND_PATH } from '../utils/roles'
import { shareFacePayId } from '../utils/share'

/** Money in is green with a plus; money out is plain with a minus; requests carry no sign because nothing moved. */
function Signed({ a }) {
  const done = a.status === 'SUCCESS'
  const sign = !done ? '' : a.direction === 'RECEIVED' ? '+' : a.direction === 'SENT' ? '−' : ''
  const tone = !done ? 'text-slate-500' : a.direction === 'RECEIVED' ? 'text-emerald-800' : ''
  return <span className={`amount font-extrabold ${tone}`}>{sign}{formatMoney(a.amount, a.currency)}</span>
}

export function ActivityRow({ a }) {
  return (
    <li>
      <Link to={ACTIVITY_DETAIL_PATH(a.ref)} className="flex items-center gap-3 rounded-xl px-1 py-3 transition hover:bg-slate-50 active:bg-slate-100">
        <Avatar name={a.counterparty_name ?? '?'} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{activityTitle(a)}</p>
          <p className="truncate text-xs text-slate-600">{a.note ? `${a.note} · ` : a.order_reference ? `${a.order_reference} · ` : ''}{formatFeedTime(a.timestamp)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Signed a={a} />
          <StatusBadge status={a.status} />
        </div>
        <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-400" />
      </Link>
    </li>
  )
}

export function ActivityList({ rows, label = 'Activity' }) {
  return <ul aria-label={label} className="divide-y divide-slate-100">{rows.map((a) => <ActivityRow key={a.ref} a={a} />)}</ul>
}

export function NoActivity({ filtered = false }) {
  return filtered ? (
    <EmptyState title="Nothing matches" icon="search">Try another filter or a different search.</EmptyState>
  ) : (
    <EmptyState title="No activity yet" action={<ButtonLink to={SEND_PATH} variant="secondary">Send money</ButtonLink>}>
      Payments you send and receive, and money requests, will show up here.
    </EmptyState>
  )
}

/** The FacePay ID with its two everyday actions. The ID is a public handle, not a secret. */
export function IdChip({ id, name, onNotice, size = 'md' }) {
  const { copied, copy } = useCopy()
  const share = async () => {
    const result = await shareFacePayId({ name, id })
    if (result === 'copied') onNotice?.('FacePay ID copied')
    else if (result === 'failed') onNotice?.('Sharing is not available here. Select the ID to copy it.')
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className={`min-w-0 break-all font-mono font-semibold ${size === 'lg' ? 'text-lg' : 'text-sm'}`} data-testid="facepay-id">{id}</p>
      <button
        type="button"
        onClick={async () => { if (!(await copy(id))) onNotice?.('Could not copy. Select the ID and copy it yourself.') }}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 text-xs font-semibold text-brand-800 transition hover:bg-brand-100"
      >
        <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
        {copied ? 'Copied' : 'Copy ID'}
      </button>
      <button type="button" onClick={share} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 text-xs font-semibold text-brand-800 transition hover:bg-brand-100">
        <Icon name="share" className="h-3.5 w-3.5" />
        Share
      </button>
    </div>
  )
}

/** Who the money goes to or comes from: name and masked ID only, as the server resolved them. */
export function PersonCard({ name, maskedId, caption }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
      <Avatar name={name} size="h-12 w-12 text-base" />
      <div className="min-w-0">
        {caption && <p className="text-xs text-slate-600">{caption}</p>}
        <p className="truncate text-lg font-bold leading-tight">{name}</p>
        {maskedId && <p className="font-mono text-xs text-slate-600">{maskedId}</p>}
      </div>
    </div>
  )
}
