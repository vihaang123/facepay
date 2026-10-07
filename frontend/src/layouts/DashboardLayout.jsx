import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Button } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { DASHBOARD_PATH, LOGIN_PATH, PROFILE_PATH } from '../utils/roles'

export default function DashboardLayout() {
  const { role, profile, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate(LOGIN_PATH[role], { replace: true })
  }

  const linkClass = ({ isActive }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      isActive ? 'bg-brand-50 text-brand-600' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="text-lg font-bold tracking-tight">FacePay</span>
            <nav aria-label="Main" className="flex gap-1">
              <NavLink to={DASHBOARD_PATH[role]} end className={linkClass}>
                Dashboard
              </NavLink>
              <NavLink to={PROFILE_PATH[role]} className={linkClass}>
                Profile
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">
              {role === 'merchant' ? profile?.business_name : profile?.name}
            </span>
            <Button variant="secondary" onClick={handleLogout}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
