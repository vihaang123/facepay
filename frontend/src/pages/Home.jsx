import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { ThemeIconButton } from '../components/ThemeSwitch'
import { Avatar, ButtonLink, Logo } from '../components/ui'
import { useHealth } from '../hooks/useHealth'

const STEPS = [
  ['Set up your face', 'Take a few photos in different poses. They are stored encrypted, and you can delete them whenever you like.', 'face'],
  ['Verify at payment', 'Open a payment request, look at the camera and follow one short instruction, such as turning your head.', 'camera'],
  ['Confirm and pay', 'Check who and how much, pick a demo bank, then confirm yourself. Nothing is paid until you do.', 'check'],
]

const PRIVACY = [
  ['What is kept', 'Small greyscale face samples and the template made from them, both encrypted. Raw camera frames are not kept after a check.'],
  ['What is never asked', 'Real bank details, card numbers, OTPs or UPI PINs. Bank accounts here are demo records.'],
  ['Your control', 'Delete your face data at any time from Security. Face payments stay off until you set your face up.'],
]

// What the server really does with a face on every authentication attempt (see docs/face-authentication.md).
const PIPELINE = [
  ['Camera', 'A few frames from your camera: two looking straight, the rest during the head turn.'],
  ['Face detection', 'A detector finds one face per frame. More than one face, and the attempt is rejected.'],
  ['Preprocessing', 'Crop, shrink to 64 × 64 grey pixels, even out brightness and contrast.'],
  ['PCA', 'Principal Component Analysis keeps the directions that carry most of the variation (about 95%).'],
  ['LDA', 'Linear Discriminant Analysis picks the directions that best tell enrolled people apart.'],
  ['Classifier', 'K-nearest-neighbours or a linear SVM names the closest enrolled person.'],
  ['Identity decision', 'It must be you, with enough confidence, and close enough to your own face profile.'],
  ['Liveness', 'A basic challenge: the face has to move the way it was asked to. This is not full anti-spoofing.'],
  ['Authorization', 'If everything passes, the server issues a one-time ticket for this payment only.'],
]

function Status({ label, ok, detail }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`} />
      <span className="text-fg">{label}</span>
      <span className={`font-semibold ${ok ? 'text-success-ink' : 'text-danger-ink'}`}>{detail}</span>
    </span>
  )
}

/** A static preview of the real confirmation screen, so a visitor sees the product, not a scanner. Nothing in it is live. */
function ConfirmPreview() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-xs">
      <div className="rounded-[2rem] border border-line bg-surface p-5 shadow-pop">
        <div className="flex items-center gap-3">
          <Avatar name="Chai Corner" size="h-11 w-11 text-sm" />
          <div>
            <p className="text-xs text-muted">Pay to</p>
            <p className="font-semibold leading-tight">Chai Corner</p>
          </div>
        </div>
        <p className="amount mt-6 text-center text-5xl font-bold">₹499.00</p>
        <p className="mt-1 text-center text-xs text-muted">Order CC-2041</p>
        <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-success-soft px-3.5 py-3 ring-1 ring-inset ring-success-line">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success text-on-accent"><Icon name="check" className="h-4 w-4" strokeWidth="3" /></span>
          <div>
            <p className="text-sm font-semibold text-success-ink">Face verified</p>
            <p className="text-xs text-success-ink">Authorization valid for 2:00</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sunken"><Icon name="bank" className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1"><p className="text-sm font-semibold">HDFC Bank</p><p className="font-mono text-xs text-muted">DEMO-••••-3089</p></div>
        </div>
        <div className="mt-5 flex min-h-12 items-center justify-center rounded-xl bg-brand-700 text-sm font-semibold text-on-accent">Confirm and pay</div>
      </div>
      <p className="mt-4 text-center text-xs font-semibold text-muted">Demo screen. Simulated payment, no real money moves.</p>
    </div>
  )
}

export default function Home() {
  const { loading, data, error } = useHealth()

  return (
    <div className="min-h-screen bg-canvas">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo className="text-xl" tile="h-9 w-9" />
        <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
          <ThemeIconButton />
          <Link to="/login" className="whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-sunken">Sign in</Link>
          <span className="hidden sm:inline-flex"><ButtonLink to="/start">Get started</ButtonLink></span>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-8 sm:px-6 md:grid-cols-[1.1fr_1fr] md:pt-16">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning-ink ring-1 ring-inset ring-warning-line">
              Prototype / Academic Project
            </p>
            <h1 className="type-display mt-5 sm:text-6xl sm:leading-[1.02]">Pay with your face.</h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              FacePay uses facial authentication to authorize simulated digital payments. You see who you are paying and how much, verify your face, then confirm. All payments are simulated: no real money moves.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink to="/start" size="lg" className="sm:w-auto sm:px-8">Get started</ButtonLink>
              <ButtonLink to="/login" variant="secondary" size="lg" className="sm:w-auto sm:px-8">Sign in</ButtonLink>
            </div>
            <p className="mt-5 text-sm text-muted">
              Selling something? <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/merchant/login">Merchant sign in</Link>
              {' or '}
              <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/merchant/register">create a merchant account</Link>.
            </p>
          </div>
          <ConfirmPreview />
        </section>

        <section id="how" aria-labelledby="how-title" className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-title" className="type-page">How it works</h2>
            <ol className="mt-8 grid gap-8 md:grid-cols-3">
              {STEPS.map(([title, text, icon], i) => (
                <li key={title} className="flex gap-4">
                  <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Icon name={icon} className="h-5 w-5" /></span>
                  <div>
                    <h3 className="type-section"><span className="sr-only">Step {i + 1}: </span>{title}</h3>
                    <p className="type-support mt-1">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="privacy-title" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="privacy-title" className="type-page">Your face data</h2>
          <p className="type-support mt-2 max-w-xl">You are asked to agree before any photo is taken. This is what happens with it.</p>
          <dl className="mt-6 grid gap-6 md:grid-cols-3">
            {PRIVACY.map(([k, v]) => (
              <div key={k} className="rounded-2xl border border-line bg-surface p-5">
                <dt className="type-section">{k}</dt>
                <dd className="type-support mt-1.5">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="honest" className="mx-auto max-w-6xl px-4 pb-14 sm:px-6">
          <h2 id="honest" className="type-page">What this is, and what it is not</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="type-section text-success-ink">What it is</h3>
              <ul className="type-body mt-2 space-y-2">
                <li>A working demonstration of face authentication feeding a simulated payment flow.</li>
                <li>Server-side decisions: the browser never decides who you are or how much is charged.</li>
              </ul>
            </div>
            <div>
              <h3 className="type-section text-danger-ink">What it is not</h3>
              <ul className="type-body mt-2 space-y-2">
                <li>Not connected to any bank, card network or UPI. Bank accounts in the app are demo records, no real account is accessed and no real money moves.</li>
                <li>Not proven secure: the liveness check is basic and can be fooled by determined attackers.</li>
              </ul>
            </div>
          </div>

          <details className="mt-10 rounded-2xl border border-line bg-surface px-5 py-4">
            <summary className="type-section cursor-pointer">How verification works, step by step</summary>
            <p className="type-support mt-3 max-w-2xl">
              This is what the server does with your camera frames on each attempt, in order. The checkout screen shows the real result of each stage that applies to you.
              The server can also be switched to a pretrained deep face-embedding model in place of the PCA, LDA and classifier stages; the other stages stay the same.
            </p>
            <ol className="mt-4 grid gap-x-8 sm:grid-cols-2">
              {PIPELINE.map(([title, text], i) => (
                <li key={title} className="flex gap-3 border-t border-line py-3">
                  <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fg text-xs font-bold text-on-accent">{i + 1}</span>
                  <div>
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="type-support mt-0.5">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs sm:px-6">
          <span className="text-muted">FacePay · Facial authentication for simulated digital payments</span>
          <div aria-label="System status" role="group" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {loading && <span className="text-muted">Checking system status…</span>}
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
