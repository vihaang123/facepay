const W = 96
const H = 72

let canvas = null

/**
 * Cheap, local readings of the current video frame for on-screen guidance only: average brightness, edge strength
 * and how much the picture changed since the previous reading. Nothing leaves the browser from here.
 */
export function measureFrame(video, previous = null) {
  if (!video?.videoWidth || !video?.videoHeight) throw new Error('The camera is not ready yet.')
  canvas ??= document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Cannot read the camera frame in this browser.')
  ctx.drawImage(video, 0, 0, W, H)
  const { data } = ctx.getImageData(0, 0, W, H)

  const gray = new Float32Array(W * H)
  let sum = 0
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    gray[i] = g
    sum += g
  }
  const brightness = sum / gray.length

  // Variance of a simple Laplacian: low when the picture is soft or smeared.
  let lapSum = 0
  let lapSq = 0
  let n = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W]
      lapSum += lap
      lapSq += lap * lap
      n++
    }
  }
  const sharpness = lapSq / n - (lapSum / n) ** 2

  let motion = 0
  if (previous && previous.length === gray.length) {
    let diff = 0
    for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - previous[i])
    motion = diff / gray.length
  }
  return { brightness, sharpness, motion, signature: gray }
}
