import { Link } from 'react-router-dom'
import { Logo } from '../components/ui'

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10 sm:px-6">
      <Link to="/" aria-label="FacePay home" className="text-2xl text-ink">
        <Logo />
      </Link>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
      {footer && <p className="text-center text-sm text-slate-700">{footer}</p>}
      <p className="text-center text-xs text-slate-600">Academic prototype. Payments are simulated.</p>
    </main>
  )
}
