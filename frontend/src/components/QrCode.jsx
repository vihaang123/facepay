import { useEffect, useState } from 'react'
import { Skeleton } from './ui'

/** Renders `value` as a QR code image. The generator loads on first use so it stays out of the main bundle. */
export default function QrCode({ value, size = 224, label = 'QR code', onReady }) {
  const [svg, setSvg] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    import('qrcode')
      .then(({ default: QR }) => QR.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1b33', light: '#ffffff' } }))
      .then((markup) => {
        if (!live) return
        setSvg(markup)
        onReady?.(markup)
      })
      .catch(() => live && setFailed(true))
    return () => { live = false }
  }, [value, onReady])

  if (failed) return <p role="alert" className="text-sm text-rose-800">The QR code could not be drawn. Share the FacePay ID instead.</p>
  if (!svg) return <div role="status" aria-label="Preparing QR code"><Skeleton className="rounded-xl" style={{ width: size, height: size }} /></div>
  return (
    <img
      alt={label}
      width={size}
      height={size}
      className="rounded-xl bg-white"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
    />
  )
}
