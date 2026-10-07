import { Link } from 'react-router-dom'
import { useHealth } from '../hooks/useHealth'

function StatusRow({ label, ok, detail }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <span
        className={`inline-flex items-center gap-2 text-sm font-semibold ${
          ok ? 'text-brand-600' : 'text-rose-600'
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${ok ? 'bg-brand-500' : 'bg-rose-500'}`} />
        {detail}
      </span>
    </div>
  )
}

export default function Home() {
  const { loading, data, error } = useHealth()

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">FacePay</h1>
        <p className="mt-1 text-slate-600">
          PCA-LDA facial authentication for simulated payments.
        </p>
        <p className="mt-2 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
          Academic prototype. No real money moves.
        </p>
      </header>

      <section aria-label="System status" className="flex flex-col gap-3">
        {loading && <p className="text-sm text-slate-500">Checking system status...</p>}
        {error && <StatusRow label="Backend API" ok={false} detail={error.message} />}
        {data && (
          <>
            <StatusRow label="Backend API" ok detail="Connected" />
            <StatusRow
              label="PostgreSQL"
              ok={data.database === 'ok'}
              detail={data.database === 'ok' ? 'Connected' : 'Unreachable'}
            />
          </>
        )}
      </section>

      <nav aria-label="Get started" className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-brand-600">
        <Link to="/login">Customer sign in</Link>
        <Link to="/register">Create customer account</Link>
        <Link to="/merchant/login">Merchant sign in</Link>
        <Link to="/merchant/register">Create merchant account</Link>
      </nav>
    </main>
  )
}
