import { useCallback, useEffect, useRef, useState } from 'react'

export const CAMERA_MESSAGES = {
  denied: 'Camera access is required for FacePay authentication. Allow the camera for this site (usually the camera icon in the address bar), then try again.',
  unsupported: 'This browser cannot access a camera (it needs HTTPS or localhost).',
  error: 'The camera could not be started. Check that no other app is using it.',
}

/**
 * Camera access. status: idle | requesting | active | denied | unsupported | error.
 * `facing` picks the lens: 'user' (front, the default, used for your own face check) or 'environment' (rear, used to point at
 * someone else). A phone with the lens uses it; a laptop with one webcam falls back to that webcam. `mirrored` says whether
 * the preview should be flipped like a mirror (front camera only). The stream is stopped when the component unmounts.
 */
export function useCamera({ facing: initialFacing = 'user' } = {}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [facing, setFacing] = useState(initialFacing)
  const [mirrored, setMirrored] = useState(initialFacing === 'user')
  const [status, setStatus] = useState(() =>
    typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia ? 'idle' : 'unsupported',
  )

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStatus((s) => (s === 'unsupported' ? s : 'idle'))
  }, [])

  const start = useCallback(async (lens) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      return
    }
    const want = lens === 'user' || lens === 'environment' ? lens : facing // a click event is not a lens
    setStatus('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: want === 'environment' ? { ideal: 'environment' } : 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = stream
      const reported = stream.getVideoTracks?.()[0]?.getSettings?.().facingMode
      setFacing(want)
      setMirrored(reported ? reported === 'user' : want === 'user')
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        Promise.resolve(videoRef.current.play?.()).catch(() => {})
      }
      setStatus('active')
    } catch (err) {
      setStatus(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'error')
    }
  }, [facing])

  // Switch between the front and rear lens while the camera is on.
  const flip = useCallback(() => start(facing === 'user' ? 'environment' : 'user'), [facing, start])

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  return { videoRef, status, start, stop, flip, facing, mirrored }
}
