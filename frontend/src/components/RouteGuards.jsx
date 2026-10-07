import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { DASHBOARD_PATH, LOGIN_PATH } from '../utils/roles'
import { FullPageSpinner } from './ui'

/** Only lets `role` through. Anonymous users go to that role's login; the other role goes home. */
export function ProtectedRoute({ role }) {
  const { status, role: currentRole } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageSpinner />
  if (status !== 'authenticated') {
    return <Navigate to={LOGIN_PATH[role]} replace state={{ from: location }} />
  }
  if (currentRole !== role) return <Navigate to={DASHBOARD_PATH[currentRole]} replace />
  return <Outlet />
}

/**
 * Login/register pages: signed-in users are sent on. If ProtectedRoute bounced them here,
 * they return to the page they asked for (router state we set ourselves, not URL input,
 * so it cannot be used for an open redirect); otherwise to their dashboard.
 */
export function GuestRoute() {
  const { status, role } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageSpinner />
  if (status === 'authenticated') {
    return <Navigate to={location.state?.from?.pathname || DASHBOARD_PATH[role]} replace />
  }
  return <Outlet />
}
