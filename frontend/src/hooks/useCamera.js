import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Webcam access. status: idle | requesting | active | denied | unsupported | error.
 * The stream is stopped when the component unmounts.
 */
export function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [status, setStatus] = useState(() =>
    typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia ? 'idle' : 'unsupported',
  )

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStatus((s) => (s === 'unsupported' ? s : 'idle'))
  }, [])

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      return
    }
    setStatus('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        Promise.resolve(videoRef.current.play?.()).catch(() => {})
      }
      setStatus('active')
    } catch (err) {
      setStatus(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'error')
    }
  }, [])

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  return { videoRef, status, start, stop }
}
