import { Link } from 'react-router-dom'
import Icon from './Icon'
import { useAuth } from '../hooks/useAuth'
import { useLoad } from '../hooks/useLoad'
import { getActivityCounts } from '../services/transfers'
import { REQUESTS_PATH } from '../utils/roles'

/** Opens the payment requests waiting for this customer; the badge is the server's count, not a guess. */
export default function RequestsBell() {
  const { token } = useAuth()
  const state = useLoad(() => getActivityCounts(token), [token])
  const n = state.data?.pending_incoming_requests ?? 0
  return (
    <Link
      to={REQUESTS_PATH}
      aria-label={n > 0 ? `Notifications, ${n} request${n === 1 ? '' : 's'} waiting for you` : 'Notifications'}
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition hover:bg-sunken hover:text-fg motion-reduce:transition-none"
    >
      <Icon name="bell" className="h-5 w-5" />
      {n > 0 && <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.65rem] font-bold text-on-accent">{n > 9 ? '9+' : n}</span>}
    </Link>
  )
}
