import { Brackets, FaceGuide } from './ScanFrame'
import { Alert, Button } from './ui'
import Icon from './Icon'
import { CAMERA_MESSAGES } from '../hooks/useCamera'

const CAMERA_STATE_TEXT = {
  idle: 'Camera is off',
  requesting: 'Waiting for camera permission…',
  denied: 'Camera blocked',
  unsupported: 'Camera not available',
  error: 'Camera could not start',
}

const EDGE = { neutral: 'border-scan-edge', ok: 'border-emerald-400', bad: 'border-rose-400' }

/**
 * Dark camera stage shared by face setup and payment authentication. The preview is mirrored (like a mirror) and keeps
 * a fixed shape, so it scales to a phone without distortion. `overlay` is a short live instruction, `scanning` shows
 * the moving scan line (only while a capture is really under way), `tone` colours the frame by the real outcome.
 */
export default function CameraView({ camera, busy = false, overlay = null, scanning = false, tone = 'neutral', guide = true, controls = true, flash = false, footnote = null, guideTone = null }) {
  const { videoRef, status, start, stop } = camera
  const on = status === 'active'
  return (
    <div className="flex flex-col gap-3">
      <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden on-dark rounded-[1.5rem] bg-scan sm:aspect-[4/3] sm:max-w-md">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Camera preview"
          className={`h-full w-full -scale-x-100 object-cover ${on ? '' : 'invisible'}`}
        />
        {!on && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-slate-300">
            <Icon name="camera" className="h-10 w-10" />
            <p className="text-sm font-semibold">{CAMERA_STATE_TEXT[status]}</p>
          </div>
        )}
        <div className="absolute inset-[7%]">
          <Brackets color={EDGE[tone]} />
          {on && guide && !scanning && (tone === 'neutral' || guideTone) && (
            <FaceGuide className={`absolute left-1/2 top-1/2 h-[72%] -translate-x-1/2 -translate-y-1/2 transition-colors ${guideTone === 'ok' ? 'text-emerald-300' : guideTone === 'warn' ? 'text-amber-300' : 'text-white/45'}`} />
          )}
          {on && flash && (
            <span aria-hidden="true" className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 motion-safe:animate-pop">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg"><Icon name="check" className="h-9 w-9" strokeWidth="2.8" /></span>
              <span className="rounded-full bg-scan/80 px-3 py-1 text-sm font-semibold text-white">Captured</span>
            </span>
          )}
          {on && scanning && (
            <span aria-hidden="true" className="absolute inset-x-3 h-0.5 animate-scan rounded-full bg-scan-edge shadow-[0_0_14px_2px_rgb(94_234_212/0.7)]" />
          )}
        </div>
        {on && overlay && (
          <p aria-hidden="true" className="absolute inset-x-4 bottom-4 rounded-full bg-scan/80 px-4 py-2 text-center text-sm font-semibold text-white backdrop-blur-sm">{overlay}</p>
        )}
      </div>
      {CAMERA_MESSAGES[status] && <Alert tone="error">{CAMERA_MESSAGES[status]}</Alert>}
      {controls && <div className="flex justify-center">
        {on ? (
          <Button variant="secondary" onClick={stop} disabled={busy}>Turn camera off</Button>
        ) : (
          <Button onClick={start} loading={status === 'requesting'} disabled={status === 'unsupported'}>
            {status === 'denied' || status === 'error' ? 'Try the camera again' : 'Turn camera on'}
          </Button>
        )}
      </div>}
      <p className="text-center text-xs text-slate-600">
        {footnote ?? 'The camera is only used while you are on this page. Nothing is recorded or sent until you capture a sample or start a face check.'}
      </p>
    </div>
  )
}
