import { Link } from 'react-router-dom'
import { ButtonLink, Logo } from '../components/ui'
import { useHealth } from '../hooks/useHealth'

const STEPS = [
  ['Register your face', 'Capture a few photos in different poses. FacePay trains a PCA + LDA model on them.'],
  ['Check out with FacePay', 'A merchant creates a payment. You open the checkout and choose Pay with FacePay.'],
  ['Prove you are live', 'Follow a short on-screen instruction, such as turning your head, while the camera watches.'],
  ['Confirm the amount', 'Once your identity is verified you review the amount and confirm. The server completes the simulated payment.'],
]

function Status({ label, ok, detail }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${ok ? 'bg-brand-500' : 'bg-rose-500'}`} />
      <span className="text-slate-700">{label}</span>
      <span className={`font-medium ${ok ? 'text-brand-800' : 'text-rose-700'}`}>{detail}</span>
    </span>
  )
}

export default function Home() {
  const { loading, data, error } = useHealth()

  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo className="text-xl" />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100">Sign in</Link>
          <ButtonLink to="/register">Get started</ButtonLink>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-4 pb-14 pt-10 sm:px-6 sm:pt-16">
          <p className="inline-block rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">
            Academic prototype · payments are simulated · no real money moves
          </p>
          <h1 className="mt-5 max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">Pay with your face.</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-700">Secure digital payment authentication using facial recognition.</p>
          <p className="mt-3 max-w-2xl text-sm text-slate-600">
            FacePay is a student project that explores how a face check with a liveness challenge can authorise a payment.
            Face recognition uses PCA + LDA, a classical machine-learning method.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <ButtonLink to="/register">Create a customer account</ButtonLink>
            <ButtonLink to="/merchant/register" variant="secondary">Create a merchant account</ButtonLink>
          </div>
          <p className="mt-4 text-sm text-slate-600">
            Already registered? <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/login">Customer sign in</Link>
            {' · '}
            <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/merchant/login">Merchant sign in</Link>
          </p>
        </section>

        <section aria-labelledby="how" className="border-y border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
            <h2 id="how" className="text-2xl font-bold tracking-tight">How it works</h2>
            <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-800">{i + 1}</span>
                  <h3 className="mt-3 font-semibold">{title}</h3>
                  <p className="mt-1 text-sm text-slate-700">{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="honest" className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
          <h2 id="honest" className="text-2xl font-bold tracking-tight">What this is, and what it is not</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 p-5">
              <h3 className="font-semibold">What it is</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                <li>A working demonstration of face authentication feeding a simulated payment flow.</li>
                <li>Server-side decisions: the browser never decides who you are or how much is charged.</li>
                <li>Face samples stored encrypted and removable from your account at any time.</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 p-5">
              <h3 className="font-semibold">What it is not</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                <li>Not connected to any bank, card network or UPI. No real money moves.</li>
                <li>Not a replacement for existing payment methods or production financial infrastructure.</li>
                <li>Not proven secure: the liveness check is basic and can be fooled by determined attackers.</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs sm:px-6">
          <span className="text-slate-600">FacePay · PCA-LDA Based Facial Authentication Framework for Secure Digital Payment Simulation</span>
          <div aria-label="System status" role="group" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {loading && <span className="text-slate-600">Checking system status…</span>}
            {error && <Status label="Backend API" ok={false} detail={error.message} />}
            {data && (
              <>
                <Status label="Backend API" ok detail="Connected" />
                <Status label="PostgreSQL" ok={data.database === 'ok'} detail={data.database === 'ok' ? 'Connected' : 'Unreachable'} />
              </>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}
