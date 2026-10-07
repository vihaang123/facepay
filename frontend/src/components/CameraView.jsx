import { Alert, Button } from './ui'
import { CAMERA_MESSAGES } from '../hooks/useCamera'

const CAMERA_STATE_TEXT = {
  idle: 'Camera is off',
  requesting: 'Waiting for camera permission…',
  denied: 'Camera blocked',
  unsupported: 'Camera not available',
  error: 'Camera could not start',
}

/**
 * Camera preview shared by face setup and payment authentication. The preview is mirrored (like a mirror) and always
 * keeps its 4:3 shape, so it scales down to a phone without distortion. `overlay` is a short live instruction.
 */
export default function CameraView({ camera, busy = false, overlay = null }) {
  const { videoRef, status, start, stop } = camera
  const on = status === 'active'
  return (
    <div className="flex flex-col gap-3">
      <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-xl bg-slate-900">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Camera preview"
          className={`h-full w-full -scale-x-100 object-cover ${on ? '' : 'invisible'}`}
        />
        {!on && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-slate-200">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 10l5-3v10l-5-3M4 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
            </svg>
            <p className="text-sm font-medium">{CAMERA_STATE_TEXT[status]}</p>
          </div>
        )}
        {on && overlay && (
          <p aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-slate-900/75 px-3 py-2 text-center text-sm font-medium text-white">{overlay}</p>
        )}
      </div>
      {CAMERA_MESSAGES[status] && <Alert tone="error">{CAMERA_MESSAGES[status]}</Alert>}
      <div className="flex justify-center">
        {on ? (
          <Button variant="secondary" onClick={stop} disabled={busy}>Turn camera off</Button>
        ) : (
          <Button onClick={start} loading={status === 'requesting'} disabled={status === 'unsupported'}>
            {status === 'denied' || status === 'error' ? 'Try the camera again' : 'Turn camera on'}
          </Button>
        )}
      </div>
      <p className="text-center text-xs text-slate-600">
        The camera is only used while you are on this page. Nothing is recorded or sent until you capture a sample or start an authentication.
      </p>
    </div>
  )
}
