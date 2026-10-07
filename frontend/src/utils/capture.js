const MAX_SIDE = 640

/**
 * Grabs the current video frame as base64 JPEG (no data: prefix). The frame is only sent to the
 * server for processing; it is never stored in the browser or rendered back as an image.
 */
export function captureFrame(video, { maxSide = MAX_SIDE, quality = 0.9 } = {}) {
  const w = video?.videoWidth
  const h = video?.videoHeight
  if (!w || !h) throw new Error('The camera is not ready yet.')
  const scale = Math.min(1, maxSide / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Cannot read the camera frame in this browser.')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality).split(',')[1]
}
