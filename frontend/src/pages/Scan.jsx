import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PersonCard } from '../components/money'
import { StatusBadge } from '../components/payUi'
import { Alert, Button, FormField } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { payRequest, resolveQr } from '../services/transfers'
import { formatMoney } from '../utils/format'
import { newKey } from '../utils/money'
import { sessionIdFrom } from '../utils/paymentLink'
import { CHECKOUT_PATH, MY_QR_PATH, sendTo } from '../utils/roles'

const SCAN_EVERY_MS = 200

function RequestFound({ request, onPaid, onBack }) {
  const { token } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const pay = async () => {
    setBusy(true)
    setError(null)
    try {
      onPaid((await payRequest(token, request.request_id, newKey())).session_id)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  const mine = request.direction === 'INCOMING'
  return (
    <section aria-label="Scanned request" className="flex flex-col gap-3 rounded-[1.25rem] border border-brand-200 bg-brand-50/50 p-5">
      <PersonCard name={request.counterparty_name} maskedId={request.counterparty_masked_id} caption={mine ? 'Is asking you for' : 'You asked'} />
      <p className="amount text-3xl font-extrabold">{formatMoney(request.amount, request.currency)}</p>
      {request.note && <p className="text-sm text-slate-700">{request.note}</p>}
      <StatusBadge status={request.status} />
      {error && <Alert tone="error">{error}</Alert>}
      {request.payable && mine ? <Button size="lg" onClick={pay} loading={busy}>Review and pay</Button> : <Alert tone="info">{mine ? 'This request can no longer be paid.' : 'This is your own request. The other person pays it from their app.'}</Alert>}
      <Button variant="ghost" onClick={onBack}>Scan another code</Button>
    </section>
  )
}

export default function Scan() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const busyRef = useRef(false)
  const [camera, setCamera] = useState(() => (navigator.mediaDevices?.getUserMedia ? 'idle' : 'unsupported')) // idle | starting | on | denied | unsupported | error
  const [error, setError] = useState(null)
  const [request, setRequest] = useState(null)
  const [manual, setManual] = useState('')
  const [checking, setChecking] = useState(false)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCamera((c) => (c === 'unsupported' ? c : 'idle'))
  }, [])
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), [])

  /** A scanned or typed code is untrusted text. The server decides what it means; nothing here acts on it directly. */
  const handle = useCallback(async (payload) => {
    if (busyRef.current) return
    busyRef.current = true
    setChecking(true)
    setError(null)
    try {
      // A merchant's QR carries a checkout link for one payment. Only the session id is taken from it; the server still
      // decides whether this customer may open it.
      const bill = /\/checkout\//.test(payload) ? sessionIdFrom(payload) : null
      if (bill) {
        navigate(CHECKOUT_PATH(bill))
        return
      }
      const r = await resolveQr(token, payload)
      if (r.type === 'PAY') {
        if (r.recipient?.is_self) setError('That is your own QR code.')
        else navigate(sendTo(r.facepay_id))
      } else if (r.type === 'REQUEST') {
        setRequest(r.request)
      }
    } catch (err) {
      setError(err.status === 422 ? 'That is not a FacePay QR code.' : err.message)
    } finally {
      busyRef.current = false
      setChecking(false)
    }
  }, [token, navigate])

  const startCamera = async () => {
    setError(null)
    setCamera('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        Promise.resolve(videoRef.current.play?.()).catch(() => {})
      }
      setCamera('on')
    } catch (err) {
      setCamera(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'error')
    }
  }

  // Look for a QR code a few times a second while the camera is on. The decoder loads only now.
  useEffect(() => {
    if (camera !== 'on') return undefined
    let live = true
    let timer
    let decode = null
    import('jsqr').then((m) => { decode = m.default })
    const tick = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (live && decode && video && canvas && video.videoWidth && !busyRef.current) {
        const w = Math.min(video.videoWidth, 480)
        const h = Math.round((video.videoHeight / video.videoWidth) * w)
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(video, 0, 0, w, h)
        const code = decode(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })
        if (code?.data) {
          stopCamera()
          live = false
          handle(code.data)
          return
        }
      }
      if (live) timer = setTimeout(tick, SCAN_EVERY_MS)
    }
    timer = setTimeout(tick, SCAN_EVERY_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [camera, handle, stopCamera])

  const submitManual = (e) => {
    e.preventDefault()
    if (!manual.trim()) {
      setError('Enter a FacePay ID or paste the code.')
      return
    }
    handle(manual.trim())
  }

  const cameraMessage = {
    denied: 'Camera access was blocked. Allow the camera for this site, or enter the FacePay ID below.',
    unsupported: 'This browser cannot open a camera here. Enter the FacePay ID below instead.',
    error: 'The camera could not be started. Check that no other app is using it, or enter the FacePay ID below.',
  }[camera]

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Scan QR</h1>
        <p className="mt-1 text-sm text-slate-600">Scan a FacePay QR code to pay someone or answer a request.</p>
      </div>

      {request ? (
        <RequestFound request={request} onPaid={(sid) => navigate(CHECKOUT_PATH(sid))} onBack={() => { setRequest(null); setError(null) }} />
      ) : (
        <>
          <section aria-label="Scanner" className="overflow-hidden rounded-[1.5rem] bg-ink shadow-card">
            <div className="relative aspect-square">
              <video ref={videoRef} muted playsInline aria-label="Camera preview" className={`h-full w-full object-cover ${camera === 'on' ? '' : 'hidden'}`} />
              <canvas ref={canvasRef} className="hidden" />
              {camera === 'on' && <span aria-hidden="true" className="pointer-events-none absolute inset-[18%] rounded-3xl border-2 border-white/80" />}
              {camera !== 'on' && (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white">
                  <p className="text-sm text-white/90">{cameraMessage ?? 'Point the camera at a FacePay QR code. The picture stays on this device.'}</p>
                  {camera !== 'unsupported' && <Button onClick={startCamera} loading={camera === 'starting'} variant="secondary">{camera === 'denied' || camera === 'error' ? 'Try the camera again' : 'Turn on camera'}</Button>}
                </div>
              )}
            </div>
            {camera === 'on' && <div className="p-3"><Button variant="secondary" onClick={stopCamera} className="w-full">Turn off camera</Button></div>}
          </section>

          {checking && <Alert tone="info">Checking the code…</Alert>}
          {error && <Alert tone="error">{error}</Alert>}

          <form onSubmit={submitManual} noValidate className="flex flex-col gap-3 rounded-[1.25rem] border border-slate-200/80 bg-white p-5 shadow-card">
            <FormField label="Or enter a FacePay ID" id="manual-code" value={manual} onChange={(e) => { setManual(e.target.value); setError(null) }} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="ravi.shah@facepay" />
            <Button type="submit" variant="secondary" loading={checking}>Continue</Button>
          </form>
          <p className="text-center text-sm"><a className="font-semibold text-brand-700 underline" href={MY_QR_PATH} onClick={(e) => { e.preventDefault(); navigate(MY_QR_PATH) }}>Show my QR instead</a></p>
        </>
      )}
    </div>
  )
}
