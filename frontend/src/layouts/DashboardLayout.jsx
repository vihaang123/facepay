import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Button, Logo } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import {
  AUTHENTICATE_PATH, DASHBOARD_PATH, FACE_PATH, LOGIN_PATH, NEW_PAYMENT_PATH, PROFILE_PATH, TRANSACTIONS_PATH,
} from '../utils/roles'

const NAV = {
  customer: [
    ['Dashboard', DASHBOARD_PATH.customer, true],
    ['Face setup', FACE_PATH],
    ['Test FacePay', AUTHENTICATE_PATH],
    ['Transactions', TRANSACTIONS_PATH.customer],
    ['Profile', PROFILE_PATH.customer],
  ],
  merchant: [
    ['Dashboard', DASHBOARD_PATH.merchant, true],
    ['New payment', NEW_PAYMENT_PATH],
    ['Transactions', TRANSACTIONS_PATH.merchant],
    ['Profile', PROFILE_PATH.merchant],
  ],
}

export default function DashboardLayout() {
  const { role, profile, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)

  // The mobile menu closes when you go somewhere.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false)
  }, [location.pathname])

  const handleLogout = () => {
    logout()
    navigate(LOGIN_PATH[role], { replace: true })
  }

  const linkClass = ({ isActive }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium ${
      isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'
    }`
  const name = role === 'merchant' ? profile?.business_name : profile?.name

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold">
        Skip to content
      </a>
      <header className="no-print border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Logo className="text-lg" />
            <nav aria-label="Main" className="hidden gap-1 md:flex">
              {NAV[role].map(([label, to, end]) => (
                <NavLink key={to} to={to} end={end} className={linkClass}>{label}</NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-[12rem] truncate text-sm text-slate-700 lg:inline">{name}</span>
            <Button variant="secondary" onClick={handleLogout} className="hidden md:inline-flex">Log out</Button>
            <button
              type="button"
              className="rounded-lg border border-slate-300 p-2 md:hidden"
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen((v) => !v)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Mobile" className="border-t border-slate-200 px-4 py-3 md:hidden">
            <div className="flex flex-col gap-1">
              {NAV[role].map(([label, to, end]) => (
                <NavLink key={to} to={to} end={end} className={linkClass}>{label}</NavLink>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <span className="truncate text-sm text-slate-700">{name}</span>
              <Button variant="secondary" onClick={handleLogout}>Log out</Button>
            </div>
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="no-print border-t border-slate-200 py-4 text-center text-xs text-slate-600">
        FacePay is an academic prototype. Payments are simulated; no real money moves.
      </footer>
    </div>
  )
}
