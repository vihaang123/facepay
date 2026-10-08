import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import { Avatar, Button, Logo } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import {
  DASHBOARD_PATH, FACE_PATH, LOGIN_PATH, NEW_PAYMENT_PATH, PAY_PATH, PROFILE_PATH, TRANSACTIONS_PATH,
} from '../utils/roles'

// [label, path, icon, end]. The same list drives the desktop bar and the phone's bottom navigation.
const NAV = {
  customer: [
    ['Home', DASHBOARD_PATH.customer, 'home', true],
    ['Pay', PAY_PATH, 'link'],
    ['Activity', TRANSACTIONS_PATH.customer, 'receipt'],
    ['Face profile', FACE_PATH, 'face'],
    ['Profile', PROFILE_PATH.customer, 'user'],
  ],
  merchant: [
    ['Home', DASHBOARD_PATH.merchant, 'home', true],
    ['New payment', NEW_PAYMENT_PATH, 'plus'],
    ['Transactions', TRANSACTIONS_PATH.merchant, 'receipt'],
    ['Profile', PROFILE_PATH.merchant, 'user'],
  ],
}

export default function DashboardLayout() {
  const { role, profile, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const handleLogout = () => {
    logout()
    navigate(LOGIN_PATH[role], { replace: true })
  }

  const name = role === 'merchant' ? profile?.business_name : profile?.name
  // The payment itself is a focused task: no bottom bar while checking out, so nothing competes with the amount.
  const focused = location.pathname.startsWith('/checkout/')

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold">
        Skip to content
      </a>
      <header className="no-print sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6 md:h-16">
          <div className="flex items-center gap-8">
            <Logo className="text-lg" />
            <nav aria-label="Main" className="hidden gap-1 md:flex">
              {NAV[role].map(([label, to, , end]) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-semibold transition ${isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`}
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Avatar name={name ?? '?'} size="h-8 w-8 text-xs" />
            <span className="hidden max-w-[10rem] truncate text-sm font-semibold text-slate-800 lg:inline">{name}</span>
            <Button variant="ghost" onClick={handleLogout} className="!min-h-9 !px-3" aria-label="Log out">
              <Icon name="logout" className="h-4 w-4" />
              <span className="hidden md:inline">Log out</span>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className={`mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6 sm:py-8 ${focused ? 'pb-10' : 'pb-28 md:pb-8'}`}>
        <div key={location.pathname} className="animate-rise">
          <Outlet />
        </div>
      </main>

      <footer className="no-print border-t border-slate-200/80 px-4 py-4 text-center text-xs text-slate-600">
        FacePay is an academic prototype. Payments are simulated; no real money moves.
      </footer>

      {!focused && (
        <nav aria-label="Mobile" className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          <ul className="mx-auto flex max-w-md justify-around px-1">
            {NAV[role].map(([label, to, icon, end]) => (
              <li key={to} className="flex-1">
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.7rem] font-semibold transition ${isActive ? 'text-brand-700' : 'text-slate-600'}`}
                >
                  {({ isActive }) => (
                    <>
                      <span className={`flex h-7 w-12 items-center justify-center rounded-full transition ${isActive ? 'bg-brand-50' : ''}`}><Icon name={icon} className="h-5 w-5" /></span>
                      {label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}
