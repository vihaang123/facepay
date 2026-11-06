import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import Icon from '../components/Icon'
import IncomingRequestPrompt from '../components/IncomingRequestPrompt'
import RequestsBell from '../components/RequestsBell'
import { ThemeIconButton } from '../components/ThemeSwitch'
import { Avatar, Logo } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import {
  ACTIVITY_PATH, ADMIN_PATH, BANKS_PATH, DASHBOARD_PATH, FACE_PATH, LOGIN_PATH, MERCHANT_REQUESTS_PATH, MY_QR_PATH, NEW_PAYMENT_PATH, PAY_PATH,
  PROFILE_PATH, RECONCILIATION_PATH, REQUESTS_PATH, SCAN_PATH, SECURITY_PATH, SEND_PATH, TRANSACTIONS_PATH,
} from '../utils/roles'

// [label, path, icon, end]. Main is the short list of daily destinations: it is the sidebar's top block on a computer and
// the bottom bar on a phone, so a person finds the same five things in the same order on every screen.
const MAIN = {
  customer: [
    ['Home', DASHBOARD_PATH.customer, 'home', true],
    ['Pay', PAY_PATH, 'face'],
    ['Send', SEND_PATH, 'send'],
    ['Activity', ACTIVITY_PATH, 'receipt'],
    ['Profile', PROFILE_PATH.customer, 'user'],
  ],
  merchant: [
    ['Overview', DASHBOARD_PATH.merchant, 'home', true],
    ['Requests', MERCHANT_REQUESTS_PATH, 'list', true],
    ['New payment', NEW_PAYMENT_PATH, 'plus'],
    ['Transactions', TRANSACTIONS_PATH.merchant, 'receipt'],
    ['Profile', PROFILE_PATH.merchant, 'user'],
  ],
  admin: [['ML Lab', ADMIN_PATH, 'cpu', true]],
}

// Everything else, shown in the desktop sidebar under "More" (on a phone these live on Home and Profile).
const MORE = {
  customer: [
    ['Payment requests', REQUESTS_PATH, 'request'],
    ['Bank accounts', BANKS_PATH, 'bank'],
    ['Scan QR', SCAN_PATH, 'scan'],
    ['My QR', MY_QR_PATH, 'qr'],
    ['Face profile', FACE_PATH, 'face'],
    ['Security and PIN', SECURITY_PATH, 'shield'],
  ],
  merchant: [['Reconciliation', RECONCILIATION_PATH, 'chart']],
  admin: [],
}

const sideLink = ({ isActive }) =>
  `flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition motion-reduce:transition-none ${isActive ? 'bg-brand-50 text-brand-800' : 'text-muted hover:bg-sunken hover:text-fg'}`

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
  const wide = role === 'merchant' || role === 'admin'

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold">
        Skip to content
      </a>

      <aside className="no-print hidden border-r border-line bg-surface lg:block">
        <div className="sticky top-0 flex h-screen flex-col gap-6 overflow-y-auto px-4 py-6">
          <Logo className="px-2 text-xl" />
          <nav aria-label="Main" className="flex flex-col gap-1">
            {MAIN[role].map(([label, to, icon, end]) => (
              <NavLink key={to} to={to} end={end} className={sideLink}>
                <Icon name={icon} className="h-5 w-5" />
                {label}
              </NavLink>
            ))}
          </nav>
          {MORE[role].length > 0 && (
            <nav aria-label="More" className="flex flex-col gap-1 border-t border-line pt-4">
              <p className="px-3 pb-1 text-xs font-semibold text-subtle">More</p>
              {MORE[role].map(([label, to, icon]) => (
                <NavLink key={to} to={to} className={sideLink}>
                  <Icon name={icon} className="h-5 w-5" />
                  {label}
                </NavLink>
              ))}
            </nav>
          )}
          <p className="mt-auto px-2 text-xs text-muted">Academic prototype. Payments are simulated; no real money moves.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="no-print sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6 lg:h-16 lg:justify-end">
            <Logo className="text-lg lg:hidden" />
            <div className="flex items-center gap-1">
              {role === 'customer' && <RequestsBell />}
              <ThemeIconButton />
              <span className="ml-1 flex items-center gap-2">
                <Avatar name={name ?? '?'} size="h-8 w-8 text-xs" />
                <span className="hidden max-w-[12rem] truncate text-sm font-semibold lg:inline">{name}</span>
              </span>
              <button
                type="button"
                onClick={handleLogout}
                aria-label="Log out"
                className="ml-1 inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-muted transition hover:bg-sunken hover:text-fg motion-reduce:transition-none"
              >
                <Icon name="logout" className="h-4 w-4" />
                <span className="hidden md:inline">Log out</span>
              </button>
            </div>
          </div>
        </header>

        <main id="main" className={`mx-auto w-full flex-1 px-4 py-5 sm:px-6 sm:py-8 ${wide ? 'max-w-6xl' : 'max-w-3xl'} ${focused ? 'pb-10' : 'pb-28 lg:pb-8'}`}>
          <div key={location.pathname} className="animate-rise">
            <Outlet />
          </div>
        </main>

        {role === 'customer' && <IncomingRequestPrompt />}

        <footer className="no-print border-t border-line px-4 py-4 text-center text-xs text-muted lg:hidden">
          FacePay is an academic prototype. Payments are simulated; no real money moves.
        </footer>
      </div>

      {!focused && (
        <nav aria-label="Mobile" className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <ul className="mx-auto flex max-w-md justify-around px-1">
            {MAIN[role].map(([label, to, icon, end]) => (
              <li key={to} className="flex-1">
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.7rem] font-semibold transition motion-reduce:transition-none ${isActive ? 'text-brand-700' : 'text-muted'}`}
                >
                  {({ isActive }) => (
                    <>
                      <span className={`flex h-7 w-12 items-center justify-center rounded-full transition motion-reduce:transition-none ${isActive ? 'bg-brand-50' : ''}`}><Icon name={icon} className="h-5 w-5" /></span>
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
