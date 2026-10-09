/** Turns the generated SVG into a PNG and saves it. Falls back to the SVG file if the browser cannot rasterise it. */
export async function downloadQr(svg, filename) {
  const save = (blob, name) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const svgBlob = new Blob([svg], { type: 'image/svg+xml' })
  try {
    const url = URL.createObjectURL(svgBlob)
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 640
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 640, 640)
    ctx.drawImage(img, 0, 0, 640, 640)
    URL.revokeObjectURL(url)
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('no png')
    save(png, `${filename}.png`)
    return 'png'
  } catch {
    save(svgBlob, `${filename}.svg`)
    return 'svg'
  }
}
