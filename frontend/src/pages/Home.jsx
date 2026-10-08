import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { Brackets, FaceGuide } from '../components/ScanFrame'
import { ButtonLink, Logo } from '../components/ui'
import { useHealth } from '../hooks/useHealth'

const STEPS = [
  ['Create your Face Profile', 'Take a few photos in different poses. FacePay trains a PCA + LDA model on them and keeps the samples encrypted.', 'face'],
  ['Authenticate with your face', 'Open a payment request, look at the camera and follow one short instruction, such as turning your head.', 'camera'],
  ['Authorize your payment', 'Check the amount and confirm. The server completes the simulated payment and gives you a receipt.', 'shield'],
]

// What the server really does with a face on every authentication attempt (see docs/face-authentication.md).
const PIPELINE = [
  ['Camera', 'A few frames from your camera: two looking straight, the rest during the head turn.'],
  ['Face detection', 'A classical detector finds one face per frame. More than one face, and the attempt is rejected.'],
  ['Preprocessing', 'Crop, shrink to 64 × 64 grey pixels, even out brightness and contrast.'],
  ['PCA', 'Principal Component Analysis keeps the directions that carry most of the variation (about 95%).'],
  ['LDA', 'Linear Discriminant Analysis picks the directions that best tell enrolled people apart.'],
  ['Classifier', 'K-nearest-neighbours or a linear SVM names the closest enrolled person.'],
  ['Identity decision', 'It must be you, with enough confidence, and close enough to your own face profile.'],
  ['Liveness', 'A basic challenge: the face has to move the way it was asked to. This is not full anti-spoofing.'],
  ['Authorization', 'If everything passes, the server issues a one-time ticket for this payment only.'],
]

const STACK = [
  ['Computer vision', 'camera'], ['PCA', 'cpu'], ['LDA', 'cpu'], ['Machine learning', 'cpu'], ['FastAPI', 'link'], ['PostgreSQL', 'database'],
]

function Status({ label, ok, detail }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${ok ? 'bg-brand-500' : 'bg-rose-500'}`} />
      <span className="text-slate-700">{label}</span>
      <span className={`font-semibold ${ok ? 'text-brand-800' : 'text-rose-700'}`}>{detail}</span>
    </span>
  )
}

/** Illustration only: a phone-sized scan frame. Nothing in it is live. */
function HeroVisual() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-[19rem]">
      <div className="relative aspect-[3/4] overflow-hidden rounded-[2rem] bg-scan p-5 shadow-pop ring-1 ring-white/10">
        <div className="relative h-full overflow-hidden rounded-2xl bg-[radial-gradient(ellipse_at_50%_35%,#14304a_0%,#07111f_70%)]">
          <FaceGuide className="absolute left-1/2 top-[12%] h-[62%] -translate-x-1/2 text-scan-edge/60" />
          <Brackets className="m-4" />
          <span className="animate-scan absolute inset-x-8 top-10 h-0.5 rounded-full bg-scan-edge shadow-[0_0_12px_2px_#5eead4]" style={{ '--scan-range': '15rem' }} />
          <p className="absolute inset-x-6 bottom-6 rounded-full bg-scan/80 px-3 py-1.5 text-center text-xs font-semibold text-white">Keep your face inside the frame</p>
        </div>
      </div>
      <p className="absolute -bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3.5 py-2 text-xs font-bold text-slate-900 shadow-pop">
        <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" strokeWidth="3" />Simulated: no real money
      </p>
    </div>
  )
}

export default function Home() {
  const { loading, data, error } = useHealth()

  return (
    <div className="min-h-screen bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo className="text-xl" tile="h-9 w-9" />
        <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
          <Link to="/login" className="rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-100">Sign in</Link>
          <ButtonLink to="/register" className="hidden sm:inline-flex">Try FacePay</ButtonLink>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-8 sm:px-6 md:grid-cols-[1.15fr_1fr] md:pt-14">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-900 ring-1 ring-inset ring-amber-200">
              Prototype / Academic Project
            </p>
            <h1 className="mt-5 text-[2.75rem] font-extrabold leading-[1.02] tracking-tight sm:text-6xl">Pay with your face.</h1>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-slate-700">
              FacePay uses facial authentication to authorize simulated digital payments.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink to="/register" size="lg" className="sm:w-auto sm:px-8">Try FacePay</ButtonLink>
              <ButtonLink to="#how" variant="secondary" size="lg" className="sm:w-auto sm:px-8" onClick={(e) => { e.preventDefault(); document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }) }}>
                How it works
              </ButtonLink>
            </div>
            <p className="mt-5 text-sm text-slate-600">
              Already have an account? <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/login">Customer sign in</Link>
              {' or '}
              <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/merchant/login">merchant sign in</Link>.
            </p>
          </div>
          <HeroVisual />
        </section>

        <section id="how" aria-labelledby="how-title" className="scroll-mt-4 border-y border-slate-200 bg-canvas">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="how-title" className="text-3xl font-extrabold tracking-tight">Three steps, one face</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {STEPS.map(([title, text, icon], i) => (
                <li key={title} className="flex gap-4 md:flex-col">
                  <div className="flex items-center gap-3 md:justify-between">
                    <span aria-hidden="true" className="amount text-4xl font-extrabold text-brand-700">{String(i + 1).padStart(2, '0')}</span>
                    <span aria-hidden="true" className="hidden h-11 w-11 items-center justify-center rounded-xl bg-white text-brand-700 shadow-card md:flex"><Icon name={icon} className="h-5 w-5" /></span>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">{title}</h3>
                    <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-slate-700">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-8 text-sm text-slate-600">
              Selling something? <Link className="font-semibold text-brand-700 underline underline-offset-2" to="/merchant/register">Create a merchant account</Link> to send payment requests.
            </p>
          </div>
        </section>

        <section aria-labelledby="verify-title" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="verify-title" className="text-3xl font-extrabold tracking-tight">How FacePay verifies you</h2>
          <p className="mt-2 max-w-xl text-slate-700">
            This is what the server does with your camera frames on each attempt, in order. The checkout screen shows the real result of each stage that applies to you.
          </p>
          <ol className="mt-8 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {PIPELINE.map(([title, text], i) => (
              <li key={title} className="flex gap-3 border-t border-slate-200 py-4">
                <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span>
                <div>
                  <h3 className="font-bold">{title}</h3>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-700">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="stack-title" className="bg-scan on-dark">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
            <h2 id="stack-title" className="text-sm font-semibold text-slate-300">Powered by</h2>
            <ul className="mt-4 flex flex-wrap gap-2.5">
              {STACK.map(([label, icon]) => (
                <li key={label} className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white">
                  <Icon name={icon} className="h-4 w-4 text-scan-edge" />{label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="honest" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="honest" className="text-2xl font-extrabold tracking-tight">What this is, and what it is not</h2>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="font-bold text-brand-800">What it is</h3>
              <ul className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">
                <li>A working demonstration of face authentication feeding a simulated payment flow.</li>
                <li>Server-side decisions: the browser never decides who you are or how much is charged.</li>
                <li>Face samples stored encrypted and removable from your account at any time.</li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold text-rose-800">What it is not</h3>
              <ul className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">
                <li>Not connected to any bank, card network or UPI. No real money moves.</li>
                <li>Not a replacement for existing payment methods or production financial infrastructure.</li>
                <li>Not proven secure: the liveness check is basic and can be fooled by determined attackers.</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs sm:px-6">
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
