import { Link } from 'react-router-dom'
import { Logo } from '../components/ui'

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10 sm:px-6">
      <Link to="/" aria-label="FacePay home" className="text-2xl text-fg">
        <Logo />
      </Link>
      <div className="rounded-3xl border border-line/80 bg-surface p-6 shadow-card">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
      {footer && <p className="text-center text-sm text-fg">{footer}</p>}
      <p className="text-center text-xs text-muted">Academic prototype. Payments are simulated.</p>
    </main>
  )
}
